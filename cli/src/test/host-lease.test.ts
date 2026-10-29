import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { acquireSessionCommandLock } from "../host/guard.js";

describe("host claim and release", () => {
  let project: string;
  let watcher: ChildProcess | null;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  function claim() {
    return run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", randomUUID(), "--json");
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-lease-")));
    watcher = null;
    const init = run("init", "--minimal", project);
    assert.equal(init.status, 0, init.stderr);
  });

  afterEach(() => {
    if (watcher?.pid) watcher.kill("SIGKILL");
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("claims once, blocks traditional writes, and releases only the matching lease", () => {
    const first = claim();
    assert.equal(first.status, 0, first.stdout);
    const lease = JSON.parse(first.stdout);
    assert.equal(lease.status, "claimed");
    assert.equal(lease.host, "herdr");
    assert.equal(lease.project_realpath, project);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease", "record.json")), true);

    const second = claim();
    assert.equal(second.status, 4);
    assert.equal(JSON.parse(second.stdout).code, "HOST_BUSY");
    assert.equal(run("submit-ralph", "[PLAN] blocked").status, 4);
    assert.equal(run("host", "inspect", "--project", project, "--json").status, 0);

    const wrong = run("host", "release", "--project", project, "--lease-id", randomUUID(), "--json");
    assert.equal(wrong.status, 4);
    assert.equal(JSON.parse(wrong.stdout).code, "LEASE_MISMATCH");

    const released = run("host", "release", "--project", project, "--lease-id", lease.lease_id, "--json");
    assert.equal(released.status, 0, released.stdout);
    assert.equal(JSON.parse(released.stdout).status, "released");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease")), false);
    assert.equal(fs.existsSync(path.join(project, ".rll-host-command-lock")), false);
    assert.equal(run("init", "--minimal", project).status, 0);
  });

  it("rejects a concurrent CLI mutation lock without creating a lease", () => {
    const release = acquireSessionCommandLock(path.join(project, ".dual-agent"));
    try {
      const result = claim();
      assert.equal(result.status, 4);
      assert.equal(JSON.parse(result.stdout).code, "HOST_BUSY");
      assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease")), false);
    } finally {
      release();
    }
  });

  it("refuses an active watcher process even without a tmux session", () => {
    const state = path.join(project, ".dual-agent");
    watcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(state, "watcher.sh")], { stdio: "ignore" });
    assert.ok(watcher.pid);
    fs.writeFileSync(path.join(state, "watcher.pid"), String(watcher.pid));
    const result = claim();
    assert.equal(result.status, 4, result.stdout);
    assert.equal(JSON.parse(result.stdout).code, "HOST_BUSY");
    assert.equal(fs.existsSync(path.join(state, "host", "lease")), false);
  });

  it("refuses a live RLL tmux session before creating the lease", () => {
    const bin = path.join(project, "test-bin");
    fs.mkdirSync(bin);
    const tmux = path.join(bin, "tmux");
    fs.writeFileSync(tmux, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(tmux, 0o755);
    const result = spawnSync(process.execPath, [cli, "host", "claim", "--project", project,
      "--host", "herdr", "--owner-id", randomUUID(), "--json"], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 4, result.stdout);
    assert.equal(JSON.parse(result.stdout).code, "HOST_BUSY");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease")), false);
  });

  it("refuses an incomplete reservation and pending intents on release", () => {
    const host = path.join(project, ".dual-agent", "host");
    fs.mkdirSync(path.join(host, "lease"), { recursive: true });
    assert.equal(JSON.parse(claim().stdout).code, "HOST_BUSY");
    fs.rmdirSync(path.join(host, "lease"));

    const lease = JSON.parse(claim().stdout);
    const intents = path.join(host, "intents");
    fs.mkdirSync(intents);
    fs.writeFileSync(path.join(intents, "pending.json"), "{}\n");
    const blocked = run("host", "release", "--project", project, "--lease-id", lease.lease_id, "--json");
    assert.equal(blocked.status, 7);
    assert.equal(JSON.parse(blocked.stdout).code, "NEEDS_RECONCILE");
    assert.equal(fs.existsSync(path.join(host, "lease")), true);
  });

  it("rejects a legacy session without rewriting its business files", () => {
    const state = path.join(project, ".dual-agent");
    fs.unlinkSync(path.join(state, "session.json"));
    const turnBefore = fs.readFileSync(path.join(state, "turn.txt"), "utf8");
    const result = claim();
    assert.equal(result.status, 3);
    assert.equal(JSON.parse(result.stdout).code, "ADOPT_REQUIRED");
    assert.equal(fs.readFileSync(path.join(state, "turn.txt"), "utf8"), turnBefore);
    assert.equal(fs.existsSync(path.join(state, "host")), false);
  });
});
