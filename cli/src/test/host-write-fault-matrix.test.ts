import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { prepareLisaSubmission, prepareRalphSubmission } from "../submission-write.js";
import { acquireSessionCommandLock } from "../host/guard.js";

const cli = path.join(__dirname, "..", "cli.js");
const commitModule = path.join(__dirname, "..", "host", "commit.js");
const content = "[PLAN] Review the task\n\nTest Plan: npm test\n";
const lisaContent = "[PASS] Plan approved.\nReason: commands.ts:42 matches the task requirements.\n";

interface Fixture {
  project: string;
  state: string;
  host: string;
  leaseId: string;
  candidateId: string;
  requestId: string;
  bindingGeneration: number;
  generationBefore: number;
  businessWriteCount: number;
  run: (...args: string[]) => ReturnType<typeof spawnSync>;
  commitArgs: string[];
}

function fixture(role: "ralph" | "lisa"): Fixture {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-write-fault-")));
  const state = path.join(project, ".dual-agent");
  const host = path.join(state, "host");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args],
    { cwd: project, encoding: "utf8" });
  assert.equal(run("init", "--minimal", project).status, 0);
  const claim = run("host", "claim", "--project", project,
    "--host", "herdr", "--owner-id", randomUUID(), "--json");
  assert.equal(claim.status, 0, claim.stdout);
  const leaseId = JSON.parse(claim.stdout).lease_id as string;
  const bind = run("host", "bind-seat", "--project", project,
    "--lease-id", leaseId, "--role", "ralph", "--workspace-id", "workspace-1",
    "--pane-id", "pane-r", "--agent-target", "agent-r", "--json");
  assert.equal(bind.status, 0, bind.stdout);
  let bindingGeneration = JSON.parse(bind.stdout).binding_generation as number;
  const digest = JSON.parse(run("host", "snapshot", "--project", project, "--json").stdout as string).state_digest;
  assert.equal(run("host", "prepare-generation", "--project", project,
    "--lease-id", leaseId, "--expected-digest", digest, "--json").status, 0);
  let candidateId = randomUUID();
  let requestId = randomUUID();
  fs.writeFileSync(path.join(project, "proposal.md"), content);
  assert.equal(run("host", "propose", "--project", project, "--role", "ralph",
    "--file", "proposal.md", "--candidate-id", candidateId, "--json").status, 0);
  let args = ["--project", project, "--lease-id", leaseId, "--request-id", requestId,
    "--candidate-id", candidateId, "--expected-generation", "0",
    "--expected-binding-generation", String(bindingGeneration)];
  const check = run("host", "commit-check", ...args, "--json");
  assert.equal(check.status, 0, check.stdout);
  const confirm = run("host", "confirm-candidate", ...args,
    "--expected-content-sha256", JSON.parse(check.stdout as string).content_sha256,
    "--decision", "reviewed_candidate_source", "--json");
  assert.equal(confirm.status, 0, confirm.stdout);
  let generationBefore = 0;
  let selectedContent = content;
  if (role === "lisa") {
    const first = run("host", "commit", ...args, "--json");
    assert.equal(first.status, 0, first.stdout);
    const lisaBind = run("host", "bind-seat", "--project", project,
      "--lease-id", leaseId, "--role", "lisa", "--workspace-id", "workspace-1",
      "--pane-id", "pane-l", "--agent-target", "agent-l", "--json");
    assert.equal(lisaBind.status, 0, lisaBind.stdout);
    bindingGeneration = JSON.parse(lisaBind.stdout).binding_generation;
    generationBefore = 1;
    selectedContent = lisaContent;
    candidateId = randomUUID();
    requestId = randomUUID();
    fs.writeFileSync(path.join(project, "lisa-proposal.md"), selectedContent);
    const proposed = run("host", "propose", "--project", project, "--role", "lisa",
      "--file", "lisa-proposal.md", "--candidate-id", candidateId, "--json");
    assert.equal(proposed.status, 0, proposed.stdout);
    args = ["--project", project, "--lease-id", leaseId, "--request-id", requestId,
      "--candidate-id", candidateId, "--expected-generation", "1",
      "--expected-binding-generation", String(bindingGeneration)];
    const lisaCheck = run("host", "commit-check", ...args, "--json");
    assert.equal(lisaCheck.status, 0, lisaCheck.stdout);
    const lisaConfirm = run("host", "confirm-candidate", ...args,
      "--expected-content-sha256", JSON.parse(lisaCheck.stdout as string).content_sha256,
      "--decision", "reviewed_candidate_source", "--json");
    assert.equal(lisaConfirm.status, 0, lisaConfirm.stdout);
  }
  const plan = role === "ralph"
    ? prepareRalphSubmission({ projectDir: project, tag: "PLAN", external: true, content: selectedContent })
    : prepareLisaSubmission({ projectDir: project, tag: "PASS", external: true, content: selectedContent });
  assert.ok(plan.changes.every((change) => change.action === "write"));
  return { project, state, host, leaseId, candidateId, requestId, bindingGeneration, generationBefore,
    businessWriteCount: plan.changes.length, run, commitArgs: ["host", "commit", ...args, "--json"] };
}

/** Patch only the child process's filesystem calls, then kill it after a real commit write. */
const crashScript = `
  const fs = require('node:fs');
  const path = require('node:path');
  const [modulePath, project, state, host, leaseId, requestId, candidateId, binding, generation, stage] = process.argv.slice(1);
  const die = () => process.kill(process.pid, 'SIGKILL');
  const target = (part) => path.join(host, part);
  const originalOpen = fs.openSync;
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if ((stage === 'intent:pending' && file === target('intents/' + requestId + '.pending')) ||
        (stage === 'generation:pending' && file === target('generation.pending')) ||
        (stage === 'receipt:pending' && file === target('receipts/' + requestId + '.pending'))) die();
    return fd;
  };
  const originalWrite = fs.writeFileSync;
  let businessCount = 0;
  const businessNames = new Set(['work.md', 'review.md', 'history.md', 'last_action.txt',
    'turn.txt', 'round.txt', 'needs_work_count.txt', 'deadlock.txt']);
  fs.writeFileSync = function(file, ...args) {
    const isBusiness = typeof file === 'string' && path.dirname(file) === state &&
      businessNames.has(path.basename(file));
    if (stage === 'business:torn' && isBusiness && businessCount === 0) {
      const bytes = Buffer.from(args[0]);
      originalWrite.call(this, file, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      die();
    }
    const result = originalWrite.call(this, file, ...args);
    if (isBusiness) {
      businessCount++;
      if (stage === 'business:' + businessCount) die();
    }
    return result;
  };
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) {
    const result = originalRename.call(this, from, to);
    if ((stage === 'intent:renamed' && to === target('intents/' + requestId + '.json')) ||
        (stage === 'generation:renamed' && to === target('generation.json')) ||
        (stage === 'receipt:renamed' && to === target('receipts/' + requestId + '.json')) ||
        (stage === 'archive:renamed' && to === target('archived-intents/' + requestId + '.json'))) die();
    return result;
  };
  require(modulePath).commitHostCandidate(project, leaseId, requestId, candidateId, Number(generation), Number(binding));
  process.exit(92); // A missing cut point is a failed test.
`;

function runMatrix(role: "ralph" | "lisa") {
    const probe = fixture(role);
    const count = probe.businessWriteCount;
    fs.rmSync(probe.project, { recursive: true, force: true });
    const stages = ["intent:pending", "intent:renamed", "business:torn",
      ...Array.from({ length: count }, (_, index) => `business:${index + 1}`),
      "generation:pending", "generation:renamed", "receipt:pending",
      "receipt:renamed", "archive:renamed"];
    for (const stage of stages) {
      const item = fixture(role);
      try {
        const killed = spawnSync(process.execPath, ["-e", crashScript,
          commitModule, item.project, item.state, item.host, item.leaseId,
          item.requestId, item.candidateId, String(item.bindingGeneration),
          String(item.generationBefore), stage],
        { cwd: item.project, encoding: "utf8" });
        assert.equal(killed.signal, "SIGKILL", `${stage}: ${killed.stderr}`);
        const lock = item.run("host", "command-lock-check", "--project", item.project, "--json");
        assert.equal(lock.status, 0, `${stage}: ${lock.stdout}`);
        const evidence = JSON.parse(lock.stdout as string);
        assert.equal(evidence.status, "stale", stage);
        const retired = item.run("host", "retire-command-lock", "--project", item.project,
          "--expected-evidence", evidence.evidence_sha256,
          "--decision", "verified-stopped-no-replay", "--json");
        assert.equal(retired.status, 0, `${stage}: ${retired.stdout}`);
        const receipt = item.run("host", "receipt", "--project", item.project,
          "--request-id", item.requestId, "--json");
        const snapshot = item.run("host", "snapshot", "--project", item.project, "--json");
        if (stage === "archive:renamed") {
          assert.equal(receipt.status, 0, `${stage}: ${receipt.stdout}`);
          assert.equal(JSON.parse(receipt.stdout as string).status, "committed");
          assert.equal(snapshot.status, 0, `${stage}: ${snapshot.stdout}`);
        } else {
          assert.equal(receipt.status, 7, `${stage}: ${receipt.stdout}`);
          assert.equal(snapshot.status, 7, `${stage}: ${snapshot.stdout}`);
          const observed = JSON.parse(receipt.stdout as string);
          assert.equal(observed.status, "needs_reconcile", stage);
          if (stage === "intent:pending") {
            assert.equal(observed.reason, "interrupted_intent_write", stage);
          } else if (stage === "intent:renamed") {
            assert.equal(observed.intent?.audit_status, "before", stage);
          } else if (/^business:[0-9]+$/.test(stage)) {
            assert.equal(observed.intent?.audit_status,
              Number(stage.slice("business:".length)) === count ? "applied" : "partial", stage);
          } else if (stage === "generation:renamed") {
            assert.equal(observed.intent?.audit_status, "applied", stage);
          }
        }
        const businessBeforeRetry = ["work.md", "history.md", "last_action.txt", "turn.txt"]
          .map((name) => fs.readFileSync(path.join(item.state, name)));
        const retry = item.run(...item.commitArgs);
        if (stage === "receipt:renamed" || stage === "archive:renamed") {
          assert.equal(retry.status, 0, `${stage}: ${retry.stdout}`);
          assert.equal(JSON.parse(retry.stdout as string).status, "committed");
          assert.equal(item.run("host", "snapshot", "--project", item.project, "--json").status, 0);
        } else {
          assert.equal(retry.status, 7, `${stage}: ${retry.stdout}`);
          assert.equal(fs.existsSync(path.join(item.host, "archived-intents", `${item.requestId}.json`)), false);
          assert.deepEqual(["work.md", "history.md", "last_action.txt", "turn.txt"]
            .map((name) => fs.readFileSync(path.join(item.state, name))), businessBeforeRetry, stage);
        }
      } finally {
        fs.rmSync(item.project, { recursive: true, force: true });
      }
    }
}

describe("host commit process crash matrix", () => {
  it("freezes Ralph write cut points and safely recognizes durable receipts", () => runMatrix("ralph"));
  it("freezes Lisa write cut points and safely recognizes durable receipts", () => runMatrix("lisa"));
});

describe("Lisa commit short-lock contention", () => {
  it("waits only before lock acquisition, then commits once after the lock clears", async () => {
    const item = fixture("lisa");
    const release = acquireSessionCommandLock(item.state);
    let held = true;
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const script = `
        const fs = require('node:fs');
        const path = require('node:path');
        const original = fs.mkdirSync;
        let announced = false;
        fs.mkdirSync = function(dir, ...args) {
          if (!announced && path.basename(dir) === '.rll-host-command-lock') {
            announced = true;
            process.send('lock-attempt');
          }
          return original.call(this, dir, ...args);
        };
        process.argv = [process.execPath, process.argv[1], ...process.argv.slice(2)];
        require(process.argv[1]);
      `;
      const spawned = spawn(process.execPath, ["-e", script, cli, ...item.commitArgs],
        { cwd: item.project, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child = spawned;
      let stdout = "";
      let stderr = "";
      spawned.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      spawned.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const finished = new Promise<number | null>((resolve, reject) => {
        spawned.on("error", reject);
        spawned.on("close", resolve);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Child did not try the command lock")), 5000);
        spawned.once("message", (message) => {
          clearTimeout(timer);
          if (message !== "lock-attempt") reject(new Error("Unexpected child message"));
          else resolve();
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      release();
      held = false;
      assert.equal(await finished, 0, stderr || stdout);
      assert.equal(JSON.parse(stdout).status, "committed");
      assert.equal(JSON.parse(item.run("host", "snapshot", "--project", item.project,
        "--json").stdout as string).generation, 2);
      assert.equal(fs.readdirSync(path.join(item.host, "receipts"))
        .filter((name) => name.endsWith(".json")).length, 2);
    } finally {
      if (held) release();
      child?.kill();
      fs.rmSync(item.project, { recursive: true, force: true });
    }
  });

  it("returns HOST_BUSY without a Lisa receipt when the lock stays held", () => {
    const item = fixture("lisa");
    const release = acquireSessionCommandLock(item.state);
    try {
      const result = item.run(...item.commitArgs);
      assert.equal(result.status, 4, String(result.stdout));
      assert.equal(JSON.parse(result.stdout as string).code, "HOST_BUSY");
      assert.equal(fs.existsSync(path.join(item.host, "receipts", `${item.requestId}.json`)), false);
    } finally {
      release();
      fs.rmSync(item.project, { recursive: true, force: true });
    }
  });
});
