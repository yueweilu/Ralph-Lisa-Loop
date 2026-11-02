import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { applySubmissionPlan, prepareLisaSubmission, prepareRalphSubmission } from "../submission-write.js";
import { businessDigest } from "../host/business.js";
import { acquireHostLock, assertNoPendingIntents } from "../host/lease.js";
import { advanceGenerationAfterIntent, archiveCommittedIntent, persistCommittedReceipt, readCommittedReceipt } from "../host/receipt-store.js";
import { persistBlockedSubmission, readRejectedReceipt } from "../host/rejection.js";
import { auditHostIntent, persistHostIntent, readArchivedHostIntent, readHostIntent } from "../host/transaction.js";

describe("host write-ahead intent", () => {
  let project: string;
  let state: string;
  let host: string;
  let leaseId: string;
  let candidateId: string;
  let bindingGeneration: number;
  const content = "[PLAN] Review the task\n\nTest Plan: npm test\n";
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-intent-")));
    state = path.join(project, ".dual-agent");
    host = path.join(state, "host");
    const init = run("init", "--minimal", project);
    assert.equal(init.status, 0, init.stderr);
    const claim = run("host", "claim", "--project", project,
      "--host", "herdr", "--owner-id", randomUUID(), "--json");
    assert.equal(claim.status, 0, claim.stdout);
    leaseId = JSON.parse(claim.stdout).lease_id;
    const bind = run("host", "bind-seat", "--project", project,
      "--lease-id", leaseId, "--role", "ralph", "--workspace-id", "workspace-1",
      "--pane-id", "pane-r", "--agent-target", "agent-r", "--json");
    assert.equal(bind.status, 0, bind.stdout);
    bindingGeneration = JSON.parse(bind.stdout).binding_generation;
    const digest = JSON.parse(run("host", "snapshot", "--project", project, "--json").stdout).state_digest;
    const prepare = run("host", "prepare-generation", "--project", project,
      "--lease-id", leaseId, "--expected-digest", digest, "--json");
    assert.equal(prepare.status, 0, prepare.stdout);
    candidateId = randomUUID();
    fs.writeFileSync(path.join(project, "proposal.md"), content);
    const propose = run("host", "propose", "--project", project, "--role", "ralph",
      "--file", "proposal.md", "--candidate-id", candidateId, "--json");
    assert.equal(propose.status, 0, propose.stdout);
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  function input(planContent = content) {
    return {
      project, leaseId, candidateId, requestId: randomUUID(),
      expectedGeneration: 0, expectedBindingGeneration: bindingGeneration,
      plan: prepareRalphSubmission({ projectDir: project, tag: "PLAN", external: true, content: planContent }),
    };
  }

  function receipt(requestId: string) {
    return run("host", "receipt", "--project", project, "--request-id", requestId, "--json");
  }

  it("returns unknown only while no write or receipt metadata exists", () => {
    const requestId = randomUUID();
    const result = receipt(requestId);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).status, "unknown");
    assert.equal(JSON.parse(result.stdout).request_id, requestId);
    const malformed = receipt("not-a-uuid");
    assert.equal(malformed.status, 2);
    assert.equal(JSON.parse(malformed.stdout).code, "INVALID_ARGUMENTS");
  });

  it("leaves an allowed candidate untouched during the rejection precheck", () => {
    const request = input();
    const release = acquireHostLock(state);
    try {
      assert.equal(persistBlockedSubmission(request, content), null);
      assert.throws(() => persistBlockedSubmission(request, "[PLAN] Changed"), /Candidate content differs/);
    } finally { release(); }
    assert.equal(fs.existsSync(path.join(host, "rejections")), false);
    assert.equal(fs.existsSync(path.join(host, "intents")), false);
  });

  it("checks a candidate for submission without writing or claiming source verification", () => {
    const request = input();
    const before = ["work.md", "history.md", "turn.txt"]
      .map((name) => fs.readFileSync(path.join(state, name)));
    const check = run("host", "commit-check", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", candidateId, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(check.status, 0, check.stdout);
    const result = JSON.parse(check.stdout);
    assert.equal(result.status, "awaiting_source_confirmation");
    assert.equal(result.source_verification, "unverified");
    assert.equal(result.commit_ready, false);
    assert.equal(result.policy.result, "pass");
    assert.equal(result.gate, "not_enabled");
    assert.equal(result.request_id, request.requestId);
    assert.equal(result.pane_id, "pane-r");
    assert.equal(result.agent_target, "agent-r");
    assert.equal(result.generation_before, 0);
    assert.equal(result.binding_generation, bindingGeneration);
    assert.deepEqual(["work.md", "history.md", "turn.txt"]
      .map((name) => fs.readFileSync(path.join(state, name))), before);
    assert.equal(fs.existsSync(path.join(host, "intents")), false);
    assert.equal(JSON.parse(receipt(request.requestId).stdout).status, "unknown");
    const wrongLease = run("host", "commit-check", "--project", project,
      "--lease-id", randomUUID(), "--request-id", request.requestId,
      "--candidate-id", candidateId, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(wrongLease.status, 4);
    assert.equal(JSON.parse(wrongLease.stdout).code, "LEASE_MISMATCH");
    const stale = run("host", "commit-check", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", candidateId, "--expected-generation", "1",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(stale.status, 5);
    assert.equal(JSON.parse(stale.stdout).code, "STALE_GENERATION");
    const malformed = run("host", "commit-check", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", candidateId, "--expected-generation", "0x0",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(malformed.status, 2);
    assert.equal(JSON.parse(malformed.stdout).code, "INVALID_ARGUMENTS");
    const commit = run("host", "commit", "--project", project, "--json");
    assert.equal(commit.status, 2);
    assert.equal(JSON.parse(commit.stdout).code, "UNKNOWN_HOST_COMMAND");
  });

  it("reports a pending test gate without running its command", () => {
    const codeContent = "[CODE] Changed commands.ts:42\n\nTest Results:\n1/1 passed\n";
    const codeCandidate = randomUUID();
    fs.writeFileSync(path.join(project, "code.md"), codeContent);
    const proposed = run("host", "propose", "--project", project, "--role", "ralph",
      "--file", "code.md", "--candidate-id", codeCandidate, "--json");
    assert.equal(proposed.status, 0, proposed.stdout);
    const previous = [process.env.RL_POLICY_MODE, process.env.RL_RALPH_GATE,
      process.env.RL_GATE_COMMANDS, process.env.RL_GATE_MODE];
    process.env.RL_POLICY_MODE = "block";
    process.env.RL_RALPH_GATE = "true";
    process.env.RL_GATE_COMMANDS = "node -e \"require('fs').writeFileSync('gate-ran','yes')\"";
    process.env.RL_GATE_MODE = "block";
    try {
      const check = run("host", "commit-check", "--project", project,
        "--lease-id", leaseId, "--request-id", randomUUID(),
        "--candidate-id", codeCandidate, "--expected-generation", "0",
        "--expected-binding-generation", String(bindingGeneration), "--json");
      assert.equal(check.status, 0, check.stdout);
      assert.equal(JSON.parse(check.stdout).status, "awaiting_source_confirmation");
      assert.equal(JSON.parse(check.stdout).gate, "pending");
      assert.equal(fs.existsSync(path.join(project, "gate-ran")), false);
      assert.equal(fs.existsSync(path.join(host, "intents")), false);
    } finally {
      for (const [index, name] of ["RL_POLICY_MODE", "RL_RALPH_GATE", "RL_GATE_COMMANDS", "RL_GATE_MODE"].entries()) {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      }
    }
  });

  it("records a human source assertion and validates it across a later commit", () => {
    const request = input();
    const preflight = run("host", "commit-check", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", candidateId, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(preflight.status, 0, preflight.stdout);
    const digest = JSON.parse(preflight.stdout).content_sha256;
    const confirm = (expectedDigest: string, decision = "reviewed_candidate_source") =>
      run("host", "confirm-candidate", "--project", project,
        "--lease-id", leaseId, "--request-id", request.requestId,
        "--candidate-id", candidateId, "--expected-generation", "0",
        "--expected-binding-generation", String(bindingGeneration),
        "--expected-content-sha256", expectedDigest, "--decision", decision, "--json");
    const wrongDigest = confirm("0".repeat(64));
    assert.equal(wrongDigest.status, 5);
    assert.equal(JSON.parse(wrongDigest.stdout).code, "STALE_CANDIDATE");
    assert.equal(confirm(digest, "automatic_verified").status, 2);
    assert.equal(fs.existsSync(path.join(host, "confirmations")), false);
    const first = confirm(digest);
    assert.equal(first.status, 0, first.stdout);
    const asserted = JSON.parse(first.stdout);
    assert.equal(asserted.status, "human_asserted");
    assert.equal(asserted.source_verification, "unverified");
    assert.equal(asserted.request_id, request.requestId);
    assert.equal(asserted.content_sha256, digest);
    assert.deepEqual(JSON.parse(confirm(digest).stdout), asserted);
    const afterConfirmation = run("host", "commit-check", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", candidateId, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(afterConfirmation.status, 0, afterConfirmation.stdout);
    assert.equal(JSON.parse(afterConfirmation.stdout).status, "human_source_asserted");
    assert.equal(JSON.parse(afterConfirmation.stdout).human_confirmation, "asserted");
    assert.equal(JSON.parse(afterConfirmation.stdout).source_verification, "unverified");
    assert.equal(fs.existsSync(path.join(host, "intents")), false);
    assert.equal(JSON.parse(receipt(request.requestId).stdout).status, "unknown");
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 0);
    const release = acquireHostLock(state);
    try {
      persistHostIntent(request);
      applySubmissionPlan(request.plan);
      advanceGenerationAfterIntent(host, request.requestId);
      persistCommittedReceipt(host, request.requestId,
        { policy: { result: "pass", warnings: [] }, gate: { result: "not_enabled" } });
      archiveCommittedIntent(host, request.requestId);
    } finally { release(); }
    assert.equal(JSON.parse(receipt(request.requestId).stdout).status, "committed");
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 0);
    const confirmationFile = path.join(host, "confirmations", `${request.requestId}.json`);
    const confirmationBytes = fs.readFileSync(confirmationFile);
    fs.unlinkSync(confirmationFile);
    assert.equal(receipt(request.requestId).status, 7);
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
    fs.writeFileSync(confirmationFile, confirmationBytes);
    const indexFile = path.join(host, "confirmations", "index.json");
    fs.writeFileSync(indexFile, "{}\n");
    assert.equal(receipt(request.requestId).status, 7);
  });

  it("stores a policy rejection without changing business state or generation", () => {
    const blockedContent = "[CODE] Implementation done";
    const blockedCandidate = randomUUID();
    fs.writeFileSync(path.join(project, "blocked.md"), blockedContent);
    const propose = run("host", "propose", "--project", project, "--role", "ralph",
      "--file", "blocked.md", "--candidate-id", blockedCandidate, "--json");
    assert.equal(propose.status, 0, propose.stdout);
    const request = { ...input(blockedContent), candidateId: blockedCandidate,
      plan: prepareRalphSubmission({ projectDir: project, tag: "CODE", external: true, content: blockedContent }) };
    const secondRejection = { ...request, requestId: randomUUID() };
    const before = ["work.md", "history.md", "turn.txt"].map((name) => fs.readFileSync(path.join(state, name)));
    const generation = fs.readFileSync(path.join(host, "generation.json"));
    const previousMode = process.env.RL_POLICY_MODE;
    process.env.RL_POLICY_MODE = "block";
    const preflight = run("host", "commit-check", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", blockedCandidate, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(preflight.status, 0, preflight.stdout);
    assert.equal(JSON.parse(preflight.stdout).status, "policy_blocked");
    assert.equal(JSON.parse(preflight.stdout).policy.result, "block");
    const blockedConfirmation = run("host", "confirm-candidate", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", blockedCandidate, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration),
      "--expected-content-sha256", JSON.parse(preflight.stdout).content_sha256,
      "--decision", "reviewed_candidate_source", "--json");
    assert.equal(blockedConfirmation.status, 6);
    assert.equal(JSON.parse(blockedConfirmation.stdout).code, "POLICY_BLOCKED");
    assert.equal(fs.existsSync(path.join(host, "confirmations")), false);
    assert.equal(fs.existsSync(path.join(host, "rejections")), false);
    const release = acquireHostLock(state);
    let rejected;
    try {
      rejected = persistBlockedSubmission(request, blockedContent);
      assert.equal(rejected?.status, "rejected");
      assert.equal(rejected?.code, "POLICY_BLOCKED");
      assert.deepEqual(persistBlockedSubmission(request, blockedContent), rejected);
      assert.equal(persistBlockedSubmission(secondRejection, blockedContent)?.status, "rejected");
      assert.throws(() => persistHostIntent(request), /already belongs to a rejected submission/);
    } finally {
      release();
      if (previousMode === undefined) delete process.env.RL_POLICY_MODE;
      else process.env.RL_POLICY_MODE = previousMode;
    }
    assert.deepEqual(readRejectedReceipt(host, request.requestId), rejected);
    assert.deepEqual(["work.md", "history.md", "turn.txt"].map((name) => fs.readFileSync(path.join(state, name))), before);
    assert.deepEqual(fs.readFileSync(path.join(host, "generation.json")), generation);
    const lookup = receipt(request.requestId);
    assert.equal(lookup.status, 0, lookup.stdout);
    assert.equal(JSON.parse(lookup.stdout).status, "rejected");
    const repeatedCheck = run("host", "commit-check", "--project", project,
      "--lease-id", leaseId, "--request-id", request.requestId,
      "--candidate-id", blockedCandidate, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration), "--json");
    assert.equal(repeatedCheck.status, 5);
    assert.equal(JSON.parse(repeatedCheck.stdout).code, "DUPLICATE_CONFLICT");
    assert.equal(JSON.parse(receipt(secondRejection.requestId).stdout).status, "rejected");
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 0);
    const continuedCandidate = randomUUID();
    const continuedFile = path.join(project, "continued.md");
    fs.writeFileSync(continuedFile, content);
    const continuedProposal = run("host", "propose", "--project", project, "--role", "ralph",
      "--file", "continued.md", "--candidate-id", continuedCandidate, "--json");
    assert.equal(continuedProposal.status, 0, continuedProposal.stdout);
    const continued = { ...input(), candidateId: continuedCandidate };
    const continueRelease = acquireHostLock(state);
    try {
      persistHostIntent(continued);
      applySubmissionPlan(continued.plan);
      advanceGenerationAfterIntent(host, continued.requestId);
      persistCommittedReceipt(host, continued.requestId,
        { policy: { result: "pass", warnings: [] }, gate: { result: "not_enabled" } });
      archiveCommittedIntent(host, continued.requestId);
    } finally { continueRelease(); }
    const resumed = run("host", "snapshot", "--project", project, "--json");
    assert.equal(resumed.status, 0, resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).generation, 1);
    assert.equal(JSON.parse(receipt(request.requestId).stdout).status, "rejected");
    assert.equal(JSON.parse(receipt(secondRejection.requestId).stdout).status, "rejected");
    assert.equal(JSON.parse(receipt(continued.requestId).stdout).status, "committed");
    assert.equal(run("host", "recovery-check", "--project", project, "--json").status, 0);
    const intentsDir = path.join(host, "intents");
    const unexpectedIntent = path.join(intentsDir, `${randomUUID()}.json`);
    fs.writeFileSync(unexpectedIntent, "{}\n");
    assert.equal(receipt(request.requestId).status, 7);
    fs.unlinkSync(unexpectedIntent);
    const pending = path.join(host, "rejections", `${request.requestId}.pending`);
    fs.writeFileSync(pending, "partial");
    assert.equal(receipt(request.requestId).status, 7);
    fs.unlinkSync(pending);
    const rejectedFile = path.join(host, "rejections", `${request.requestId}.json`);
    const rejectedBytes = fs.readFileSync(rejectedFile);
    fs.unlinkSync(rejectedFile);
    assert.equal(receipt(secondRejection.requestId).status, 7);
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
    fs.writeFileSync(rejectedFile, rejectedBytes);
    const rejectionIndex = path.join(host, "rejections", "index.json");
    const indexBytes = fs.readFileSync(rejectionIndex);
    fs.writeFileSync(rejectionIndex, "{}\n");
    assert.equal(receipt(request.requestId).status, 7);
    fs.writeFileSync(rejectionIndex, indexBytes);
    assert.equal(receipt(request.requestId).status, 0);
    fs.writeFileSync(rejectedFile, "{}\n");
    assert.equal(receipt(request.requestId).status, 7);
    assert.equal(receipt(continued.requestId).status, 7);
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
  });

  it("records a blocked test gate once and skips it on the same request retry", () => {
    const codeContent = "[CODE] Implementation with test evidence";
    const codeCandidate = randomUUID();
    fs.writeFileSync(path.join(project, "gate.md"), codeContent);
    assert.equal(run("host", "propose", "--project", project, "--role", "ralph",
      "--file", "gate.md", "--candidate-id", codeCandidate, "--json").status, 0);
    const request = { ...input(codeContent), candidateId: codeCandidate,
      plan: prepareRalphSubmission({ projectDir: project, tag: "CODE", external: true, content: codeContent }) };
    const previous = [process.env.RL_POLICY_MODE, process.env.RL_RALPH_GATE,
      process.env.RL_GATE_COMMANDS, process.env.RL_GATE_MODE];
    process.env.RL_POLICY_MODE = "off";
    process.env.RL_RALPH_GATE = "true";
    process.env.RL_GATE_COMMANDS = "test-command";
    process.env.RL_GATE_MODE = "block";
    const release = acquireHostLock(state);
    try {
      const rejected = persistBlockedSubmission(request, codeContent, (_command, cwd) => {
        assert.equal(cwd, project);
        throw new Error("test gate failed");
      });
      assert.equal(rejected?.code, "GATE_BLOCKED");
      assert.equal(rejected?.gate.result, "block");
      assert.deepEqual(persistBlockedSubmission(request, codeContent, () => assert.fail("gate ran again")), rejected);
    } finally {
      release();
      for (const [index, name] of ["RL_POLICY_MODE", "RL_RALPH_GATE", "RL_GATE_COMMANDS", "RL_GATE_MODE"].entries()) {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      }
    }
    assert.equal(JSON.parse(receipt(request.requestId).stdout).code, "GATE_BLOCKED");
    assert.equal(fs.readFileSync(path.join(state, "turn.txt"), "utf8"), "ralph");
  });

  it("treats interrupted intent writes and unsupported receipt metadata as uncertain", () => {
    const requestId = randomUUID();
    const intents = path.join(host, "intents");
    fs.mkdirSync(intents);
    const pendingFile = path.join(intents, `${requestId}.pending`);
    fs.writeFileSync(pendingFile, "partial");
    const interrupted = receipt(requestId);
    assert.equal(interrupted.status, 7);
    assert.equal(JSON.parse(interrupted.stdout).reason, "interrupted_intent_write");
    fs.unlinkSync(pendingFile);
    fs.mkdirSync(path.join(host, "receipts"));
    const unsupported = receipt(requestId);
    assert.equal(unsupported.status, 7);
    assert.equal(JSON.parse(unsupported.stdout).reason, "receipt_store_requires_review");
  });

  it("persists only hashes before any business write and freezes snapshot and release", () => {
    const workBefore = fs.readFileSync(path.join(state, "work.md"));
    const turnBefore = fs.readFileSync(path.join(state, "turn.txt"));
    const release = acquireHostLock(state);
    let intent;
    try { intent = persistHostIntent(input()); } finally { release(); }
    assert.equal(intent.status, "prepared");
    assert.equal(intent.source_verification, "unverified");
    assert.equal(intent.generation_before, 0);
    assert.equal(intent.changes.length, 4);
    assert.equal(JSON.stringify(intent).includes(content), false);
    assert.deepEqual(readHostIntent(host, intent.request_id), intent);
    assert.deepEqual(fs.readFileSync(path.join(state, "work.md")), workBefore);
    assert.deepEqual(fs.readFileSync(path.join(state, "turn.txt")), turnBefore);
    const pending = receipt(intent.request_id);
    assert.equal(pending.status, 7);
    assert.equal(JSON.parse(pending.stdout).status, "needs_reconcile");
    assert.equal(JSON.parse(pending.stdout).intent.content_sha256, intent.content_sha256);
    assert.equal(JSON.parse(pending.stdout).intent.audit_status, "before");
    assert.equal(auditHostIntent(host, intent.request_id).status, "before");
    const other = receipt(randomUUID());
    assert.equal(other.status, 7);
    assert.equal(JSON.parse(other.stdout).reason, "another_request_needs_reconcile");
    const snapshot = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snapshot.status, 7);
    assert.equal(JSON.parse(snapshot.stdout).code, "NEEDS_RECONCILE");
    const releaseAttempt = run("host", "release", "--project", project, "--lease-id", leaseId, "--json");
    assert.equal(releaseAttempt.status, 7);
  });

  it("records the expected after digest for an interrupted post-write transaction", () => {
    const request = input();
    const release = acquireHostLock(state);
    let intent;
    try {
      intent = persistHostIntent(request);
      applySubmissionPlan(request.plan);
    } finally { release(); }
    assert.equal(businessDigest(state, "lisa", 1, "planning"), intent.state_digest_after);
    const snapshot = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snapshot.status, 7);
    assert.equal(JSON.parse(snapshot.stdout).code, "NEEDS_RECONCILE");
    assert.equal(fs.existsSync(path.join(host, "receipts")), false);
    const pending = receipt(intent.request_id);
    assert.equal(pending.status, 7);
    assert.equal(JSON.parse(pending.stdout).status, "needs_reconcile");
    assert.equal(JSON.parse(pending.stdout).intent.audit_status, "applied");
  });

  it("advances generation only after audited writes and stores one immutable receipt", () => {
    const request = input();
    const release = acquireHostLock(state);
    try {
      const intent = persistHostIntent(request);
      const checks = { policy: { result: "pass" as const, warnings: [] },
        gate: { result: "not_enabled" as const } };
      assert.throws(() => advanceGenerationAfterIntent(host, request.requestId), /Business writes do not match/);
      assert.throws(() => persistCommittedReceipt(host, request.requestId, checks), /Business writes do not match/);
      applySubmissionPlan(request.plan);
      assert.throws(() => persistCommittedReceipt(host, request.requestId, checks), /Generation was not advanced/);
      const generation = advanceGenerationAfterIntent(host, request.requestId);
      assert.equal(generation.generation, 1);
      assert.equal(generation.last_receipt_id, request.requestId);
      assert.equal(generation.state_digest, intent.state_digest_after);
      assert.deepEqual(advanceGenerationAfterIntent(host, request.requestId), generation);
      assert.throws(() => archiveCommittedIntent(host, request.requestId), /No committed receipt/);
      const committed = persistCommittedReceipt(host, request.requestId, checks);
      assert.equal(committed.status, "committed");
      assert.equal(committed.generation_after, 1);
      assert.equal(committed.state_digest_after, intent.state_digest_after);
      assert.deepEqual(readCommittedReceipt(host, request.requestId), committed);
      assert.deepEqual(persistCommittedReceipt(host, request.requestId, checks), committed);
      assert.throws(() => persistCommittedReceipt(host, request.requestId,
        { policy: { result: "warn", warnings: ["changed"] }, gate: checks.gate }),
      /Existing receipt differs/);
      assert.deepEqual(archiveCommittedIntent(host, request.requestId), committed);
      assert.deepEqual(archiveCommittedIntent(host, request.requestId), committed);
      assert.equal(readHostIntent(host, request.requestId), null);
      assert.deepEqual(readArchivedHostIntent(host, request.requestId), intent);
      assertNoPendingIntents(host);
    } finally { release(); }
    const committed = receipt(request.requestId);
    assert.equal(committed.status, 0, committed.stdout);
    assert.equal(JSON.parse(committed.stdout).status, "committed");
    assert.equal(JSON.parse(committed.stdout).generation_after, 1);
    const resumed = run("host", "snapshot", "--project", project, "--json");
    assert.equal(resumed.status, 0, resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).generation, 1);
    assert.equal(JSON.parse(resumed.stdout).last_receipt_id, request.requestId);
    const archivedFile = path.join(host, "archived-intents", `${request.requestId}.json`);
    const activeCopy = path.join(host, "intents", `${request.requestId}.json`);
    fs.copyFileSync(archivedFile, activeCopy);
    assert.equal(receipt(request.requestId).status, 7);
    fs.unlinkSync(activeCopy);
    assert.equal(receipt(request.requestId).status, 0);
    const unexpectedArchive = path.join(host, "archived-intents", "unexpected.txt");
    fs.writeFileSync(unexpectedArchive, "unexpected");
    assert.equal(receipt(request.requestId).status, 7);
    fs.unlinkSync(unexpectedArchive);
    assert.equal(receipt(request.requestId).status, 0);
    const turnFile = path.join(state, "turn.txt");
    const turnBytes = fs.readFileSync(turnFile);
    fs.writeFileSync(turnFile, "ralph\n");
    assert.equal(receipt(request.requestId).status, 7);
    fs.writeFileSync(turnFile, turnBytes);
    const generationFile = path.join(host, "generation.json");
    const generationBytes = fs.readFileSync(generationFile);
    const mismatched = JSON.parse(generationBytes.toString("utf8"));
    mismatched.state_digest = "0".repeat(64);
    fs.writeFileSync(generationFile, JSON.stringify(mismatched) + "\n");
    assert.equal(receipt(request.requestId).status, 7);
    fs.writeFileSync(generationFile, generationBytes);
    assert.equal(receipt(request.requestId).status, 0);
    const intentFile = path.join(host, "archived-intents", `${request.requestId}.json`);
    const intentBytes = fs.readFileSync(intentFile);
    const wrongIntent = JSON.parse(intentBytes.toString("utf8"));
    wrongIntent.candidate_id = randomUUID();
    fs.writeFileSync(intentFile, JSON.stringify(wrongIntent) + "\n");
    assert.equal(receipt(request.requestId).status, 7);
    fs.writeFileSync(intentFile, intentBytes);
    assert.equal(receipt(request.requestId).status, 0);
    const other = receipt(randomUUID());
    assert.equal(other.status, 0);
    assert.equal(JSON.parse(other.stdout).status, "unknown");
    const interrupted = path.join(host, "receipts", `${request.requestId}.pending`);
    fs.writeFileSync(interrupted, "partial");
    assert.equal(receipt(request.requestId).status, 7);
    fs.unlinkSync(interrupted);
    const receiptFile = path.join(host, "receipts", `${request.requestId}.json`);
    const changed = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    changed.candidate_id = randomUUID();
    fs.writeFileSync(receiptFile, JSON.stringify(changed) + "\n");
    const invalid = receipt(request.requestId);
    assert.equal(invalid.status, 7);
    assert.equal(JSON.parse(invalid.stdout).reason, "invalid_committed_receipt");
    const snapshot = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snapshot.status, 7);
  });

  it("rejects a changed business file before generation advancement", () => {
    const request = input();
    const release = acquireHostLock(state);
    try {
      persistHostIntent(request);
      applySubmissionPlan(request.plan);
      fs.writeFileSync(path.join(state, "turn.txt"), "ralph\n");
      assert.equal(auditHostIntent(host, request.requestId).status, "partial");
      assert.throws(() => advanceGenerationAfterIntent(host, request.requestId), /Business writes do not match/);
      assert.equal(fs.existsSync(path.join(host, "receipts")), false);
    } finally { release(); }
  });

  it("continues through a Lisa turn and checks both historical receipts", () => {
    const checks = { policy: { result: "pass" as const, warnings: [] },
      gate: { result: "not_enabled" as const } };
    const first = input();
    let release = acquireHostLock(state);
    try {
      persistHostIntent(first);
      applySubmissionPlan(first.plan);
      advanceGenerationAfterIntent(host, first.requestId);
      persistCommittedReceipt(host, first.requestId, checks);
      archiveCommittedIntent(host, first.requestId);
    } finally { release(); }
    const bind = run("host", "bind-seat", "--project", project,
      "--lease-id", leaseId, "--role", "lisa", "--workspace-id", "workspace-1",
      "--pane-id", "pane-l", "--agent-target", "agent-l", "--json");
    assert.equal(bind.status, 0, bind.stdout);
    const lisaBindingGeneration = JSON.parse(bind.stdout).binding_generation;
    const blockedLisaContent = "[PASS] Looks fine";
    const blockedLisaCandidate = randomUUID();
    fs.writeFileSync(path.join(project, "blocked-lisa.md"), blockedLisaContent);
    const blockedProposal = run("host", "propose", "--project", project, "--role", "lisa",
      "--file", "blocked-lisa.md", "--candidate-id", blockedLisaCandidate, "--json");
    assert.equal(blockedProposal.status, 0, blockedProposal.stdout);
    const blockedLisaRequest = {
      project, leaseId, candidateId: blockedLisaCandidate, requestId: randomUUID(),
      expectedGeneration: 1, expectedBindingGeneration: lisaBindingGeneration,
      plan: prepareLisaSubmission({ projectDir: project, tag: "PASS", external: true,
        content: blockedLisaContent }),
    };
    const previousPolicyMode = process.env.RL_POLICY_MODE;
    process.env.RL_POLICY_MODE = "block";
    release = acquireHostLock(state);
    try {
      assert.equal(persistBlockedSubmission(blockedLisaRequest, blockedLisaContent)?.code, "POLICY_BLOCKED");
    } finally {
      release();
      if (previousPolicyMode === undefined) delete process.env.RL_POLICY_MODE;
      else process.env.RL_POLICY_MODE = previousPolicyMode;
    }
    const lisaContent = "[APPROVE] Reviewed the plan and approved it.\n";
    const lisaCandidateId = randomUUID();
    fs.writeFileSync(path.join(project, "proposal-lisa.md"), lisaContent);
    const propose = run("host", "propose", "--project", project, "--role", "lisa",
      "--file", "proposal-lisa.md", "--candidate-id", lisaCandidateId, "--json");
    assert.equal(propose.status, 0, propose.stdout);
    const second = {
      project, leaseId, candidateId: lisaCandidateId, requestId: randomUUID(),
      expectedGeneration: 1, expectedBindingGeneration: lisaBindingGeneration,
      plan: prepareLisaSubmission({ projectDir: project, tag: "APPROVE", external: true, content: lisaContent }),
    };
    const priorReceiptFile = path.join(host, "receipts", `${first.requestId}.json`);
    const priorReceiptBytes = fs.readFileSync(priorReceiptFile);
    fs.writeFileSync(priorReceiptFile, "{}\n");
    release = acquireHostLock(state);
    try {
      assert.throws(() => persistHostIntent(second), /Invalid committed receipt/);
    } finally { release(); }
    assert.equal(fs.existsSync(path.join(host, "intents", `${second.requestId}.json`)), false);
    fs.writeFileSync(priorReceiptFile, priorReceiptBytes);
    release = acquireHostLock(state);
    try {
      persistHostIntent(second);
      applySubmissionPlan(second.plan);
      advanceGenerationAfterIntent(host, second.requestId);
      persistCommittedReceipt(host, second.requestId, checks);
      archiveCommittedIntent(host, second.requestId);
    } finally { release(); }
    const snapshot = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snapshot.status, 0, snapshot.stdout);
    assert.equal(JSON.parse(snapshot.stdout).generation, 2);
    assert.equal(JSON.parse(snapshot.stdout).turn, "ralph");
    assert.equal(JSON.parse(snapshot.stdout).round, 2);
    assert.equal(JSON.parse(snapshot.stdout).last_receipt_id, second.requestId);
    const preparedAgain = run("host", "prepare-generation", "--project", project,
      "--lease-id", leaseId, "--expected-digest", JSON.parse(snapshot.stdout).state_digest, "--json");
    assert.equal(preparedAgain.status, 0, preparedAgain.stdout);
    assert.equal(JSON.parse(preparedAgain.stdout).generation, 2);
    const recovery = run("host", "recovery-check", "--project", project, "--json");
    assert.equal(recovery.status, 0, recovery.stdout);
    assert.equal(JSON.parse(receipt(first.requestId).stdout).status, "committed");
    assert.equal(JSON.parse(receipt(second.requestId).stdout).status, "committed");
    assert.equal(JSON.parse(receipt(blockedLisaRequest.requestId).stdout).status, "rejected");
    const firstReceiptFile = path.join(host, "receipts", `${first.requestId}.json`);
    const firstReceiptBytes = fs.readFileSync(firstReceiptFile);
    fs.unlinkSync(firstReceiptFile);
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
    assert.equal(receipt(second.requestId).status, 7);
    assert.equal(run("host", "recovery-check", "--project", project, "--json").status, 7);
    fs.writeFileSync(firstReceiptFile, firstReceiptBytes);
    const secondIntentFile = path.join(host, "archived-intents", `${second.requestId}.json`);
    const secondIntentBytes = fs.readFileSync(secondIntentFile);
    const wrongLink = JSON.parse(secondIntentBytes.toString("utf8"));
    wrongLink.state_digest_before = "0".repeat(64);
    fs.writeFileSync(secondIntentFile, JSON.stringify(wrongLink) + "\n");
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
    assert.equal(receipt(first.requestId).status, 7);
    fs.writeFileSync(secondIntentFile, secondIntentBytes);
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 0);
  });

  it("rejects a receipt directory symlink", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rll-receipts-outside-"));
    try {
      fs.symlinkSync(outside, path.join(host, "receipts"));
      assert.throws(() => readCommittedReceipt(host, randomUUID()), /Invalid host receipt directory/);
      const lookup = receipt(randomUUID());
      assert.equal(lookup.status, 7);
      assert.equal(JSON.parse(lookup.stdout).reason, "invalid_receipt_directory");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("identifies a partly applied write without treating it as committed", () => {
    const request = input();
    const release = acquireHostLock(state);
    let intent;
    try {
      intent = persistHostIntent(request);
      fs.writeFileSync(path.join(state, request.plan.changes[0].name), request.plan.changes[0].after_bytes!);
    } finally { release(); }
    const audit = auditHostIntent(host, intent.request_id);
    assert.equal(audit.status, "partial");
    assert.equal(audit.files[0].matches_after, true);
    assert.equal(audit.files[1].matches_before, true);
    const lookup = receipt(intent.request_id);
    assert.equal(lookup.status, 7);
    assert.equal(JSON.parse(lookup.stdout).intent.audit_status, "partial");
  });

  it("rejects a candidate-content mismatch without writing an intent", () => {
    const release = acquireHostLock(state);
    try {
      assert.throws(() => persistHostIntent(input("[PLAN] Different\n\nTest Plan: npm test\n")),
        /Candidate differs from the planned submission/);
    } finally { release(); }
    assert.equal(fs.existsSync(path.join(host, "intents")), false);
  });

  it("refuses another intent and detects a changed intent record", () => {
    const request = input();
    const release = acquireHostLock(state);
    let intent;
    try {
      intent = persistHostIntent(request);
      assert.throws(() => persistHostIntent(input()), /Resolve pending host intents/);
    } finally { release(); }
    const file = path.join(host, "intents", `${intent.request_id}.json`);
    const changed = JSON.parse(fs.readFileSync(file, "utf8"));
    changed.changes[0].name = "../work.md";
    fs.writeFileSync(file, JSON.stringify(changed) + "\n");
    assert.throws(() => readHostIntent(host, intent.request_id), /Invalid host intent/);
    const pending = receipt(intent.request_id);
    assert.equal(pending.status, 7);
    assert.equal(JSON.parse(pending.stdout).reason, "invalid_intent_record");
  });

  it("keeps receipt status uncertain if a business file is torn after intent", () => {
    const request = input();
    const release = acquireHostLock(state);
    try { persistHostIntent(request); } finally { release(); }
    fs.writeFileSync(path.join(state, "turn.txt"), "");
    const result = receipt(request.requestId);
    assert.equal(result.status, 7);
    assert.equal(JSON.parse(result.stdout).status, "needs_reconcile");
    assert.equal(JSON.parse(result.stdout).session_id, null);
  });
});
