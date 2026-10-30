import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { applySubmissionPlan, prepareRalphSubmission } from "../submission-write.js";
import { businessDigest } from "../host/business.js";
import { acquireHostLock } from "../host/lease.js";
import { auditHostIntent, persistHostIntent, readHostIntent } from "../host/transaction.js";

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
