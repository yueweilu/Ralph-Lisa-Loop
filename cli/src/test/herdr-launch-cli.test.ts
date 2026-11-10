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
  it("waits for a durable started result after a transient blocked observation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rll-entry-blocked-"));
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    const writer = path.join(root, "write-result.js");
    fs.writeFileSync(writer, `const fs = require("node:fs");
const path = require("node:path");
setTimeout(() => {
  const state = path.join(process.env.FAKE_PROJECT, ".dual-agent");
  const intent = JSON.parse(fs.readFileSync(path.join(state, "herdr-launch-intent.json")));
  fs.writeFileSync(path.join(state, "herdr-launch-result.json"),
    JSON.stringify({ schema: 1, request_id: intent.request_id, status: "started" }));
}, 1200);
`);
    const fakeHerdr = path.join(root, "herdr-stub.js");
    fs.writeFileSync(fakeHerdr, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const reply = (result) => console.log(JSON.stringify({ result }));
if (args[0] === "--version") console.log("herdr 0.9.4");
else if (args[0] === "status" && args[1] === "server")
  console.log(JSON.stringify({ status: "running", running: true }));
else if (args[0] === "plugin" && args[1] === "list")
  reply({ plugins: [{ plugin_id: "ralph-lisa.loop", enabled: true,
    version: "0.1.8", panes: [{ id: "coordinator" }] }] });
else if (args[0] === "workspace" && args[1] === "create")
  reply({ type: "workspace_created", workspace: { workspace_id: "w1" },
    root_pane: { pane_id: "w1:p1", terminal_id: "term-r", workspace_id: "w1" } });
else if (args[0] === "plugin" && args[1] === "pane") {
  spawn(process.execPath, [process.env.FAKE_WRITER],
    { detached: true, stdio: "ignore", env: process.env }).unref();
  reply({ type: "plugin_pane_opened", plugin_pane: { pane: {
    pane_id: "w1:p2", workspace_id: "w1" } } });
} else if (args[0] === "agent" && args[1] === "get")
  reply({ agent: { name: "ralph", agent: "claude", workspace_id: "w1",
    cwd: process.env.FAKE_PROJECT, agent_status: "blocked", pane_id: "w1:p1" } });
else process.exitCode = 2;
`);
    fs.chmodSync(fakeHerdr, 0o700);
    try {
      const run = spawnSync(process.execPath,
        [alias, "--project", project, "Plan a README"],
        { cwd: root, encoding: "utf8", timeout: 15000,
          env: { ...process.env, HERDR_BIN_PATH: fakeHerdr,
            FAKE_PROJECT: project, FAKE_WRITER: writer } });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(JSON.parse(run.stdout).status, "started");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

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
  { plugin_id: "ralph-lisa.loop", version: process.env.FAKE_PLUGIN_VERSION || "0.1.4",
    enabled: true, panes: [{ id: "coordinator" }] }
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
      const outdated = spawnSync(process.execPath,
        [cli, "auto", "--host", "herdr", "--project", project, "Task"],
        { cwd: root, encoding: "utf8", timeout: 15000,
          env: { ...process.env, HERDR_BIN_PATH: fakeHerdr, RLL_HERDR_SESSION: "rll-test",
            FAKE_PLUGIN_VERSION: "0.1.2" } });
      assert.equal(outdated.status, 3);
      assert.match(outdated.stderr, /HERDR_PLUGIN_VERSION_REQUIRED/);
      assert.equal(fs.existsSync(path.join(project, ".dual-agent")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
