import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { acquireSessionCommandLock } from "../host/guard.js";

describe("host process fault boundaries", () => {
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

  function confirm(requestId: string) {
    const args = ["--project", project, "--lease-id", leaseId, "--request-id", requestId,
      "--candidate-id", candidateId, "--expected-generation", "0",
      "--expected-binding-generation", String(bindingGeneration)];
    const preflight = run("host", "commit-check", ...args, "--json");
    assert.equal(preflight.status, 0, preflight.stdout);
    const confirmed = run("host", "confirm-candidate", ...args,
      "--expected-content-sha256", JSON.parse(preflight.stdout).content_sha256,
      "--decision", "reviewed_candidate_source", "--json");
    assert.equal(confirmed.status, 0, confirmed.stdout);
    return ["host", "commit", ...args, "--json"];
  }

  function checkLock() {
    const result = run("host", "command-lock-check", "--project", project, "--json");
    assert.equal(result.status, 0, result.stdout);
    return JSON.parse(result.stdout);
  }

  function retire(evidence: string) {
    return run("host", "retire-command-lock", "--project", project,
      "--expected-evidence", evidence, "--decision", "verified-stopped-no-replay", "--json");
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-fault-")));
    state = path.join(project, ".dual-agent");
    host = path.join(state, "host");
    assert.equal(run("init", "--minimal", project).status, 0);
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
    assert.equal(run("host", "prepare-generation", "--project", project,
      "--lease-id", leaseId, "--expected-digest", digest, "--json").status, 0);
    candidateId = randomUUID();
    fs.writeFileSync(path.join(project, "proposal.md"), content);
    assert.equal(run("host", "propose", "--project", project, "--role", "ralph",
      "--file", "proposal.md", "--candidate-id", candidateId, "--json").status, 0);
  });

  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  it("refuses a live lock and retires a dead owner's lock without deleting evidence", () => {
    const release = acquireSessionCommandLock(state);
    try {
      const active = checkLock();
      assert.equal(active.status, "active");
      assert.equal(retire(active.evidence_sha256).status, 4);
      assert.equal(run("host", "snapshot", "--project", project, "--json").status, 4);
    } finally { release(); }
    const script = "require(process.argv[1]).acquireSessionCommandLock(process.argv[2]); process.kill(process.pid, 'SIGKILL')";
    const killed = spawnSync(process.execPath, ["-e", script,
      path.join(__dirname, "..", "host", "guard.js"), state], { cwd: project });
    assert.equal(killed.signal, "SIGKILL");
    const stale = checkLock();
    assert.equal(stale.status, "stale");
    assert.equal(retire("0".repeat(64)).status, 5);
    const retired = retire(stale.evidence_sha256);
    assert.equal(retired.status, 0, retired.stdout);
    const record = JSON.parse(retired.stdout);
    assert.equal(record.status, "retired");
    assert.equal(fs.existsSync(path.join(project, record.retired_relative_path, "owner.json")), true);
    assert.equal(checkLock().status, "absent");
    assert.equal(JSON.parse(run("host", "snapshot", "--project", project, "--json").stdout).generation, 0);
    fs.mkdirSync(path.join(project, ".rll-host-command-lock"));
    const incomplete = run("host", "command-lock-check", "--project", project, "--json");
    assert.equal(incomplete.status, 7);
    assert.equal(JSON.parse(incomplete.stdout).code, "NEEDS_RECONCILE");
    assert.equal(retire(stale.evidence_sha256).status, 7);
  });

  it("keeps an interrupted transaction frozen after process death and lock retirement", () => {
    const requestId = randomUUID();
    const args = confirm(requestId);
    const script = `
      const { acquireHostLock } = require(process.argv[1]);
      const { persistHostIntent } = require(process.argv[2]);
      const { prepareRalphSubmission } = require(process.argv[3]);
      const fs = require('node:fs');
      const path = require('node:path');
      const [project, state, leaseId, requestId, candidateId, binding, content] = process.argv.slice(4);
      acquireHostLock(state);
      const plan = prepareRalphSubmission({ projectDir: project, tag: 'PLAN', external: true, content });
      persistHostIntent({ project, leaseId, requestId, candidateId,
        expectedGeneration: 0, expectedBindingGeneration: Number(binding), plan });
      const first = plan.changes.find(change => change.action === 'write');
      fs.writeFileSync(path.join(state, first.name), first.after_bytes);
      process.kill(process.pid, 'SIGKILL');
    `;
    const killed = spawnSync(process.execPath, ["-e", script,
      path.join(__dirname, "..", "host", "lease.js"),
      path.join(__dirname, "..", "host", "transaction.js"),
      path.join(__dirname, "..", "submission-write.js"),
      project, state, leaseId, requestId, candidateId, String(bindingGeneration), content],
    { cwd: project, encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    const stale = checkLock();
    assert.equal(stale.status, "stale");
    assert.equal(retire(stale.evidence_sha256).status, 0);
    const outcome = run("host", "receipt", "--project", project, "--request-id", requestId, "--json");
    assert.equal(outcome.status, 7);
    assert.equal(JSON.parse(outcome.stdout).intent.audit_status, "partial");
    const snapshot = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snapshot.status, 7);
    assert.equal(JSON.parse(snapshot.stdout).code, "NEEDS_RECONCILE");
    assert.equal(run(...args).status, 7);
    assert.equal(fs.existsSync(path.join(host, "intents", `${requestId}.json`)), true);
  });

  it("allows only one of two different requests to consume the same generation", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const firstArgs = confirm(firstId);
    const secondArgs = confirm(secondId);
    function concurrent(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd: project });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    }
    const outcomes = await Promise.all([concurrent(firstArgs), concurrent(secondArgs)]);
    assert.equal(outcomes.filter((item) => item.code === 0).length, 1, JSON.stringify(outcomes));
    assert.ok([4, 5].includes(outcomes.find((item) => item.code !== 0)!.code!),
      JSON.stringify(outcomes));
    const winner = outcomes.find((item) => item.code === 0)!;
    assert.equal(JSON.parse(winner.stdout).status, "committed");
    const snap = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snap.status, 0, snap.stdout);
    assert.equal(JSON.parse(snap.stdout).generation, 1);
    assert.equal(fs.readdirSync(path.join(host, "receipts")).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(run(...(JSON.parse(winner.stdout).request_id === firstId ? firstArgs : secondArgs)).status, 0);
    assert.equal(run(...(JSON.parse(winner.stdout).request_id === firstId ? secondArgs : firstArgs)).status, 5);
  });
});
