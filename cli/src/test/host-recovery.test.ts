import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

describe("explicit host lease recovery", () => {
  let project: string;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  function claim(owner = randomUUID()) {
    const result = run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", owner, "--json");
    assert.equal(result.status, 0, result.stdout);
    return JSON.parse(result.stdout);
  }

  function check() {
    return run("host", "recovery-check", "--project", project, "--json");
  }

  function recover(leaseId: string, evidence: string, decision = "verified-stopped-no-replay") {
    return run("host", "recover-lease", "--project", project,
      "--lease-id", leaseId, "--expected-evidence", evidence, "--decision", decision, "--json");
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-recovery-")));
    const init = run("init", "--minimal", project);
    assert.equal(init.status, 0, init.stderr);
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("archives the reviewed lease, preserves business state, and permits a new claim", () => {
    const owner = randomUUID();
    const lease = claim(owner);
    const bind = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
      "--role", "ralph", "--workspace-id", "workspace-1", "--pane-id", "pane-1",
      "--agent-target", "agent-1", "--json");
    assert.equal(bind.status, 0, bind.stdout);
    const state = path.join(project, ".dual-agent");
    const businessBefore = fs.readFileSync(path.join(state, "task.md"));
    const planResult = check();
    assert.equal(planResult.status, 0, planResult.stdout);
    const plan = JSON.parse(planResult.stdout);
    assert.equal(plan.status, "review_required");
    assert.equal(plan.lease_id, lease.lease_id);
    assert.equal(plan.owner_id, owner);
    assert.equal(plan.heartbeat_seq, 0);
    assert.equal(plan.binding_generation, 1);
    assert.deepEqual(plan.required_checks, ["coordinator_stopped", "herdr_agents_stopped", "no_unrecorded_delivery"]);
    assert.equal(recover(lease.lease_id, plan.evidence_sha256, "yes").status, 2);
    assert.equal(recover(randomUUID(), plan.evidence_sha256).status, 4);
    const result = recover(lease.lease_id, plan.evidence_sha256);
    assert.equal(result.status, 0, result.stdout);
    const recovered = JSON.parse(result.stdout);
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.replay, "not_replayed");
    assert.deepEqual(fs.readFileSync(path.join(state, "task.md")), businessBefore);
    assert.equal(fs.existsSync(path.join(project, recovered.archive_relative_path, "record.json")), true);
    assert.equal(fs.existsSync(path.join(state, "host", "lease")), false);
    assert.equal(fs.existsSync(path.join(state, "host", "reconcile.json")), false);
    assert.equal(fs.existsSync(path.join(state, "host", "recoveries", `${recovered.recovery_id}.json`)), true);
    const snapshot = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snapshot.status, 0, snapshot.stdout);
    assert.equal(JSON.parse(snapshot.stdout).host_state, "unclaimed");
    assert.equal(JSON.parse(snapshot.stdout).binding_state, "stale");
    assert.equal(run("host", "heartbeat", "--project", project, "--lease-id", lease.lease_id,
      "--owner-id", owner, "--json").status, 4);
    assert.equal(claim().status, "claimed");
  });

  it("rejects recovery if the coordinator heartbeats after the check", () => {
    const lease = claim();
    const plan = JSON.parse(check().stdout);
    const beat = run("host", "heartbeat", "--project", project,
      "--lease-id", lease.lease_id, "--owner-id", lease.owner_id, "--json");
    assert.equal(beat.status, 0, beat.stdout);
    const result = recover(lease.lease_id, plan.evidence_sha256);
    assert.equal(result.status, 5);
    assert.equal(JSON.parse(result.stdout).code, "RECOVERY_STALE");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease", "record.json")), true);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "reconcile.json")), false);
  });

  it("rejects recovery when business state changes after the check", () => {
    const lease = claim();
    const plan = JSON.parse(check().stdout);
    fs.appendFileSync(path.join(project, ".dual-agent", "work.md"), "external write\n");
    const result = recover(lease.lease_id, plan.evidence_sha256);
    assert.equal(result.status, 5);
    assert.equal(JSON.parse(result.stdout).code, "RECOVERY_STALE");
  });

  it("refuses active tmux before archiving", () => {
    const lease = claim();
    const plan = JSON.parse(check().stdout);
    const bin = path.join(project, "bin");
    fs.mkdirSync(bin);
    const tmux = path.join(bin, "tmux");
    fs.writeFileSync(tmux, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(tmux, 0o755);
    const result = spawnSync(process.execPath, [cli, "host", "recover-lease", "--project", project,
      "--lease-id", lease.lease_id, "--expected-evidence", plan.evidence_sha256,
      "--decision", "verified-stopped-no-replay", "--json"], {
      cwd: project, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` }, encoding: "utf8",
    });
    assert.equal(result.status, 4);
    assert.equal(JSON.parse(result.stdout).code, "HOST_BUSY");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease", "record.json")), true);
  });

  it("refuses pending intents and interrupted heartbeats", () => {
    const lease = claim();
    const host = path.join(project, ".dual-agent", "host");
    const plan = JSON.parse(check().stdout);
    const intents = path.join(host, "intents");
    fs.mkdirSync(intents);
    fs.writeFileSync(path.join(intents, "pending.json"), "{}\n");
    assert.equal(recover(lease.lease_id, plan.evidence_sha256).status, 7);
    fs.unlinkSync(path.join(intents, "pending.json"));
    fs.writeFileSync(path.join(host, "lease", "record.pending"), "{}\n");
    assert.equal(recover(lease.lease_id, plan.evidence_sha256).status, 7);
    assert.equal(fs.existsSync(path.join(host, "lease")), true);
  });

  it("keeps an interrupted recovery frozen instead of automatically retrying", () => {
    const lease = claim();
    const plan = JSON.parse(check().stdout);
    const host = path.join(project, ".dual-agent", "host");
    fs.writeFileSync(path.join(host, "reconcile.json"), JSON.stringify({
      schema: 1, kind: "lease_recovery", status: "archiving", lease_id: lease.lease_id,
    }) + "\n");
    const retired = path.join(host, "retired-leases");
    fs.mkdirSync(retired);
    fs.renameSync(path.join(host, "lease"), path.join(retired, lease.lease_id));
    assert.equal(check().status, 7);
    assert.equal(recover(lease.lease_id, plan.evidence_sha256).status, 7);
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
    assert.equal(run("submit-ralph", "[PLAN] blocked").status, 4);
    assert.equal(fs.existsSync(path.join(host, "reconcile.json")), true);
    assert.equal(fs.existsSync(path.join(retired, lease.lease_id, "record.json")), true);
  });
});
