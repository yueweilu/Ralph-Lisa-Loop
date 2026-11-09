import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(root, "../../cli/dist/cli.js");
const helper = path.join(root, "task-update-request.mjs");

test("Ralph Pane requests a task update without exposing a lease; Lisa is refused", () => {
  const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-task-adapter-")));
  const config = path.join(project, "plugin-config");
  fs.mkdirSync(config);
  const herdr = path.join(project, "herdr-fake");
  fs.writeFileSync(herdr, `#!${process.execPath}\n` +
    `const a=process.argv.slice(2);const project=process.env.TEST_PROJECT;` +
    `const pane={pane_id:'p1',workspace_id:'w1',terminal_id:'t1'};` +
    `const role=process.env.TEST_ROLE||'ralph';` +
    `if(a[0]==='pane'&&a[1]==='current')console.log(JSON.stringify({result:{pane}}));` +
    `else if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{` +
    `name:role,agent:role==='ralph'?'claude':'codex',pane_id:'p1',workspace_id:'w1',` +
    `terminal_id:'t1',cwd:project,agent_status:'working'}}}));` +
    `else process.exitCode=2;\n`);
  fs.chmodSync(herdr, 0o700);
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ project,
    rll_cli_argv: [process.execPath, cli] }));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(spawnSync(process.execPath, [cli, "init", "--minimal", project],
      { cwd: project }).status, 0);
    const lease = run("host", "claim", "--project", project, "--host", "herdr",
      "--owner-id", crypto.randomUUID(), "--json");
    run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
      "--role", "ralph", "--workspace-id", "w1", "--pane-id", "p1",
      "--agent-target", "ralph", "--json");
    run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
      "--role", "lisa", "--workspace-id", "w1", "--pane-id", "p2",
      "--agent-target", "lisa", "--json");
    const baseline = run("host", "snapshot", "--project", project, "--json");
    run("host", "prepare-generation", "--project", project, "--lease-id", lease.lease_id,
      "--expected-digest", baseline.state_digest, "--json");
    const file = path.join(project, "new-task.txt");
    fs.writeFileSync(file, "Build a homepage.\n");
    const requestId = crypto.randomUUID();
    const args = [helper, "request", "--project", project, "--file", file,
      "--mode", "switch", "--request-id", requestId];
    const env = { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "p1",
      HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: herdr, HERDR_SOCKET_PATH: "test-socket",
      HERDR_PLUGIN_CONFIG_DIR: config, TEST_PROJECT: project };
    const wrong = spawnSync(process.execPath, args,
      { cwd: project, env: { ...env, TEST_ROLE: "lisa" }, encoding: "utf8" });
    assert.equal(wrong.status, 4);
    assert.equal(JSON.parse(wrong.stdout).code, "CALLER_AGENT_MISMATCH");
    const accepted = spawnSync(process.execPath, args,
      { cwd: project, env, encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    const value = JSON.parse(accepted.stdout);
    assert.equal(value.status, "task_update_requested");
    assert.equal(value.request_id, requestId);
    assert.equal(value.lease_id, undefined);
    const queue = path.join(project, ".dual-agent", "host", "task-update-requests");
    const record = JSON.parse(fs.readFileSync(path.join(queue, `${requestId}.json`), "utf8"));
    assert.equal(record.content_sha256,
      crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    assert.equal(record.generation, 0);
    assert.equal(run("host", "snapshot", "--project", project, "--json").generation, 0);
    const release = spawnSync(process.execPath, [cli, "host", "release",
      "--project", project, "--lease-id", lease.lease_id, "--json"],
    { cwd: project, encoding: "utf8" });
    assert.equal(release.status, 7);
    assert.equal(JSON.parse(release.stdout).code, "NEEDS_RECONCILE");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
