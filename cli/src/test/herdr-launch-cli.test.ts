import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.join(__dirname, "..", "cli.js");
const alias = path.join(__dirname, "..", "herdr-rll.js");

describe("Herdr CLI entry points", () => {
  it("both refuse a stopped isolated server before creating session state", () => {
    const root = fs.mkdtempSync("/tmp/rll-entry-");
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    const fakeHerdr = path.join(root, "herdr-stub.js");
    fs.writeFileSync(fakeHerdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("herdr 0.9.4");
} else if (args.slice(-3).join(" ") === "status server --json") {
  console.log(JSON.stringify({ status: "not_running", running: false }));
} else {
  process.exitCode = 2;
}
`);
    fs.chmodSync(fakeHerdr, 0o700);
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"), HERDR_BIN_PATH: fakeHerdr,
      RLL_HERDR_SESSION: `rll-test-${crypto.randomUUID().slice(0, 8)}` };
    try {
      const long = spawnSync(process.execPath, [cli, "auto", "--host", "herdr", "--project", project, "Write a README"],
        { cwd: root, env, encoding: "utf8", timeout: 15000 });
      const short = spawnSync(process.execPath, [alias, "--project", project, "Write a README"],
        { cwd: root, env, encoding: "utf8", timeout: 15000 });
      assert.equal(long.status, 3);
      assert.equal(short.status, 3);
      assert.match(long.stderr, /HERDR_SERVER_NOT_RUNNING/);
      assert.match(short.stderr, /HERDR_SERVER_NOT_RUNNING/);
      assert.equal(fs.existsSync(path.join(project, ".dual-agent")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects malformed Herdr arguments without project writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rll-entry-"));
    try {
      const result = spawnSync(process.execPath,
        [cli, "auto", "--host", "herdr", "--project", root, "Task", "extra"],
        { cwd: root, encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /TASK_MUST_BE_ONE_ARGUMENT/);
      assert.equal(fs.existsSync(path.join(root, ".dual-agent")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("does not replace an existing session even when Herdr is unavailable", () => {
    const root = fs.mkdtempSync("/tmp/rll-entry-");
    try {
      const state = path.join(root, ".dual-agent");
      fs.mkdirSync(state);
      fs.writeFileSync(path.join(state, "sentinel"), "preserve me");
      const result = spawnSync(process.execPath,
        [cli, "auto", "--host", "herdr", "--project", root, "New task"],
        { cwd: root, encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 4);
      assert.match(result.stderr, /SESSION_EXISTS/);
      assert.equal(fs.readFileSync(path.join(state, "sentinel"), "utf8"), "preserve me");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects reuse of a Workspace for another project before initialization", () => {
    const root = fs.mkdtempSync("/tmp/rll-entry-");
    const project = path.join(root, "project");
    const other = path.join(root, "other");
    fs.mkdirSync(project);
    fs.mkdirSync(other);
    const fakeHerdr = path.join(root, "herdr-stub.js");
    fs.writeFileSync(fakeHerdr, `#!/usr/bin/env node
const args = process.argv.slice(2);
const tail = args.slice(2).join(" ");
if (args[0] === "--version") console.log("herdr 0.9.4");
else if (tail === "status server --json") console.log(JSON.stringify({ status: "running", running: true }));
else if (tail === "plugin list --json") console.log(JSON.stringify({ result: { plugins: [
  { plugin_id: "ralph-lisa.loop", enabled: true, panes: [{ id: "coordinator" }] }
] } }));
else if (tail === "workspace get w1") console.log(JSON.stringify({ result: { workspace: { workspace_id: "w1" } } }));
else if (tail === "pane list --workspace w1") console.log(JSON.stringify({ result: { panes: [{ cwd: process.env.FAKE_OTHER }] } }));
else process.exitCode = 2;
`);
    fs.chmodSync(fakeHerdr, 0o700);
    try {
      const result = spawnSync(process.execPath,
        [cli, "auto", "--host", "herdr", "--project", project, "Task"],
        { cwd: root, encoding: "utf8", timeout: 15000,
          env: { ...process.env, HERDR_BIN_PATH: fakeHerdr, RLL_HERDR_SESSION: "rll-test",
            RLL_HERDR_REUSE_WORKSPACE_ID: "w1", FAKE_OTHER: other } });
      assert.equal(result.status, 3, result.stdout + result.stderr);
      assert.match(result.stderr, /WORKSPACE_PROJECT_MISMATCH/);
      assert.equal(fs.existsSync(path.join(project, ".dual-agent")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
