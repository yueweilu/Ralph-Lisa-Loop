import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { acquireSessionCommandLock } from "../host/guard.js";

describe("host snapshot", () => {
  let project: string;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  function snapshot() {
    return run("host", "snapshot", "--project", project, "--json");
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-snapshot-")));
    const result = run("init", "--minimal", project);
    assert.equal(result.status, 0, result.stderr);
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("reads an identified session and hashes its business state without changing it", () => {
    const state = path.join(project, ".dual-agent");
    const before = fs.readFileSync(path.join(state, "task.md"), "utf8");
    const first = snapshot();
    assert.equal(first.status, 0, first.stdout);
    const value = JSON.parse(first.stdout);
    assert.equal(value.host_state, "unclaimed");
    assert.equal(value.turn, "ralph");
    assert.equal(value.round, 1);
    assert.equal(value.generation, null);
    assert.match(value.state_digest, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(snapshot().stdout).state_digest, value.state_digest);
    assert.equal(fs.readFileSync(path.join(state, "task.md"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(project, ".rll-host-command-lock")), false);

    fs.appendFileSync(path.join(state, "task.md"), "updated\n");
    assert.notEqual(JSON.parse(snapshot().stdout).state_digest, value.state_digest);
  });

  it("reports the owner of a claimed session without leaking the lease ID", () => {
    const owner = randomUUID();
    const claim = run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", owner, "--json");
    assert.equal(claim.status, 0, claim.stdout);
    const lease = JSON.parse(claim.stdout);
    const result = snapshot();
    assert.equal(result.status, 0, result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.host_state, "claimed");
    assert.equal(value.owner_id, owner);
    assert.equal(value.session_id, lease.session_id);
    assert.equal("lease_id" in value, false);
  });

  it("rejects a competing command lock with structured HOST_BUSY", () => {
    const release = acquireSessionCommandLock(path.join(project, ".dual-agent"));
    try {
      const result = snapshot();
      assert.equal(result.status, 4);
      assert.equal(JSON.parse(result.stdout).code, "HOST_BUSY");
    } finally {
      release();
    }
  });

  it("freezes an incomplete lease and damaged business files", () => {
    const host = path.join(project, ".dual-agent", "host");
    fs.mkdirSync(path.join(host, "lease"), { recursive: true });
    const incomplete = snapshot();
    assert.equal(incomplete.status, 7);
    assert.equal(JSON.parse(incomplete.stdout).code, "NEEDS_RECONCILE");
    fs.rmdirSync(path.join(host, "lease"));

    fs.unlinkSync(path.join(project, ".dual-agent", "work.md"));
    const damaged = snapshot();
    assert.equal(damaged.status, 7);
    assert.equal(JSON.parse(damaged.stdout).code, "STATE_INVALID");
  });

  it("does not reinterpret a legacy session as host ready", () => {
    fs.unlinkSync(path.join(project, ".dual-agent", "session.json"));
    const result = snapshot();
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).code, "ADOPT_REQUIRED");
  });

  it("uses the explicit project even when cwd and RL_STATE_DIR point elsewhere", () => {
    const elsewhere = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-other-")));
    try {
      const result = spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
        cwd: elsewhere,
        env: { ...process.env, RL_STATE_DIR: path.join(elsewhere, ".dual-agent") },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stdout);
      assert.equal(JSON.parse(result.stdout).project_realpath, project);
      assert.equal(fs.existsSync(path.join(elsewhere, ".dual-agent")), false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
