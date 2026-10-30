import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

describe("host generation baseline", () => {
  let project: string;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  function snapshot() {
    return run("host", "snapshot", "--project", project, "--json");
  }

  function claim() {
    const result = run("host", "claim", "--project", project,
      "--host", "herdr", "--owner-id", randomUUID(), "--json");
    assert.equal(result.status, 0, result.stdout);
    return JSON.parse(result.stdout);
  }

  function prepare(leaseId: string, digest: string) {
    return run("host", "prepare-generation", "--project", project,
      "--lease-id", leaseId, "--expected-digest", digest, "--json");
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-generation-")));
    const init = run("init", "--minimal", project);
    assert.equal(init.status, 0, init.stderr);
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("records generation zero without changing business files or fabricating a receipt", () => {
    const state = path.join(project, ".dual-agent");
    const before = fs.readFileSync(path.join(state, "work.md"));
    const initial = JSON.parse(snapshot().stdout);
    assert.equal(initial.generation, null);
    const lease = claim();
    const result = prepare(lease.lease_id, initial.state_digest);
    assert.equal(result.status, 0, result.stdout);
    const record = JSON.parse(result.stdout);
    assert.equal(record.generation, 0);
    assert.equal(record.state_digest, initial.state_digest);
    assert.equal(record.last_receipt_id, null);
    assert.deepEqual(fs.readFileSync(path.join(state, "work.md")), before);
    assert.deepEqual(JSON.parse(prepare(lease.lease_id, initial.state_digest).stdout), record);
    const ready = JSON.parse(snapshot().stdout);
    assert.equal(ready.generation, 0);
    assert.equal(ready.last_receipt_id, null);
    assert.equal(ready.state_digest, initial.state_digest);
    assert.equal(run("host", "release", "--project", project, "--lease-id", lease.lease_id, "--json").status, 0);
    assert.equal(JSON.parse(snapshot().stdout).generation, 0);
  });

  it("rejects a wrong lease or a stale state digest before writing", () => {
    const preclaim = JSON.parse(snapshot().stdout).state_digest;
    const noLease = prepare(randomUUID(), preclaim);
    assert.equal(noLease.status, 4);
    assert.equal(JSON.parse(noLease.stdout).code, "HOST_NOT_CLAIMED");
    const lease = claim();
    const digest = JSON.parse(snapshot().stdout).state_digest;
    const wrong = prepare(randomUUID(), digest);
    assert.equal(wrong.status, 4);
    assert.equal(JSON.parse(wrong.stdout).code, "LEASE_MISMATCH");
    fs.appendFileSync(path.join(project, ".dual-agent", "task.md"), "outside change\n");
    const stale = prepare(lease.lease_id, digest);
    assert.equal(stale.status, 5);
    assert.equal(JSON.parse(stale.stdout).code, "STALE_STATE");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "generation.json")), false);
  });

  it("freezes a prepared generation when manual use later changes business state", () => {
    const lease = claim();
    const digest = JSON.parse(snapshot().stdout).state_digest;
    assert.equal(prepare(lease.lease_id, digest).status, 0);
    assert.equal(run("host", "release", "--project", project, "--lease-id", lease.lease_id, "--json").status, 0);
    assert.equal(run("submit-ralph", "[PLAN] manual continuation").status, 0);
    const stale = snapshot();
    assert.equal(stale.status, 7);
    assert.equal(JSON.parse(stale.stdout).code, "NEEDS_RECONCILE");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "generation.json")), true);
  });

  it("keeps interrupted generation writes frozen", () => {
    const lease = claim();
    const host = path.join(project, ".dual-agent", "host");
    const digest = JSON.parse(snapshot().stdout).state_digest;
    fs.writeFileSync(path.join(host, "generation.pending"), "{}\n");
    assert.equal(prepare(lease.lease_id, digest).status, 7);
    assert.equal(snapshot().status, 7);
    assert.equal(run("host", "release", "--project", project, "--lease-id", lease.lease_id, "--json").status, 7);
    assert.equal(fs.existsSync(path.join(host, "generation.pending")), true);
  });

  it("includes the generation in recovery evidence and preserves it after archiving the lease", () => {
    const lease = claim();
    const digest = JSON.parse(snapshot().stdout).state_digest;
    assert.equal(prepare(lease.lease_id, digest).status, 0);
    const check = run("host", "recovery-check", "--project", project, "--json");
    assert.equal(check.status, 0, check.stdout);
    const plan = JSON.parse(check.stdout);
    assert.equal(plan.generation, 0);
    const recovered = run("host", "recover-lease", "--project", project,
      "--lease-id", lease.lease_id, "--expected-evidence", plan.evidence_sha256,
      "--decision", "verified-stopped-no-replay", "--json");
    assert.equal(recovered.status, 0, recovered.stdout);
    const after = JSON.parse(snapshot().stdout);
    assert.equal(after.host_state, "unclaimed");
    assert.equal(after.generation, 0);
    const next = claim();
    assert.equal(JSON.parse(prepare(next.lease_id, digest).stdout).generation, 0);
  });
});
