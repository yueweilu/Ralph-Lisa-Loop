import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireSessionCommandLock } from "../host/guard.js";

describe("host mutation guard", () => {
  let project: string;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      env: { ...process.env, RL_STATE_DIR: path.join(project, ".dual-agent") },
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-guard-")));
    const init = run("init", "--minimal", project);
    assert.equal(init.status, 0, init.stderr);
    fs.mkdirSync(path.join(project, ".dual-agent", "host"));
    fs.writeFileSync(path.join(project, ".dual-agent", "host", "lease.json"), "{}\n");
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("blocks init before changing project role files or deleting the session", () => {
    const state = path.join(project, ".dual-agent");
    const sessionBefore = fs.readFileSync(path.join(state, "session.json"), "utf8");
    const taskBefore = fs.readFileSync(path.join(state, "task.md"), "utf8");
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "existing role\n");
    const result = run("init", project);
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /controlled by a host/);
    assert.equal(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8"), "existing role\n");
    assert.equal(fs.readFileSync(path.join(state, "session.json"), "utf8"), sessionBefore);
    assert.equal(fs.readFileSync(path.join(state, "task.md"), "utf8"), taskBefore);
  });

  it("blocks mutations and destructive commands before they change the state", () => {
    const state = path.join(project, ".dual-agent");
    const before = fs.readFileSync(path.join(state, "turn.txt"), "utf8");
    for (const args of [
      ["submit-ralph", "[PLAN] hello"],
      ["step", "next"],
      ["scope-update", "changed"],
      ["subtask", "add", "item"],
      ["auto", "task"],
      ["start", "task"],
      ["stop", "--force"],
      ["clean"],
      ["uninit"],
    ]) {
      const result = run(...args);
      assert.equal(result.status, 4, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(fs.readFileSync(path.join(state, "turn.txt"), "utf8"), before);
      assert.equal(fs.existsSync(path.join(state, "session.json")), true);
    }
  });

  it("keeps read-only commands available", () => {
    assert.equal(run("status").status, 0);
    assert.equal(run("whose-turn").status, 0);
    assert.equal(run("subtask", "list").status, 0);
    const inspect = run("host", "inspect", "--project", project, "--json");
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.equal(JSON.parse(inspect.stdout).contract_state, "identified");
  });

  it("also blocks reconciliation and claim-in-progress markers", () => {
    const host = path.join(project, ".dual-agent", "host");
    fs.unlinkSync(path.join(host, "lease.json"));
    fs.writeFileSync(path.join(host, "claim.lock"), "");
    assert.equal(run("clean").status, 4);
    fs.unlinkSync(path.join(host, "claim.lock"));
    fs.writeFileSync(path.join(host, "reconcile.json"), "{}\n");
    assert.equal(run("clean").status, 4);
  });

  it("serializes mutations with an exclusive project lock", () => {
    const state = path.join(project, ".dual-agent");
    const release = acquireSessionCommandLock(state);
    try {
      assert.throws(() => acquireSessionCommandLock(state), /HOST_BUSY/);
      fs.writeFileSync(path.join(project, "CLAUDE.md"), "unchanged\n");
      const blocked = run("init", project);
      assert.equal(blocked.status, 4, blocked.stderr);
      assert.match(blocked.stderr, /HOST_BUSY/);
      assert.equal(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8"), "unchanged\n");
    } finally {
      release();
    }
    assert.equal(fs.existsSync(path.join(project, ".rll-host-command-lock")), false);
  });

  it("releases the lock after a blocked or completed CLI command", () => {
    const lockDir = path.join(project, ".rll-host-command-lock");
    assert.equal(run("step", "next").status, 4);
    assert.equal(fs.existsSync(lockDir), false);
    fs.unlinkSync(path.join(project, ".dual-agent", "host", "lease.json"));
    const init = run("init", "--minimal", project);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(fs.existsSync(lockDir), false);
  });
});
