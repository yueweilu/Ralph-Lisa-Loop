import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(root, "../../cli/dist/cli.js");
const coordinator = path.join(root, "coordinator.mjs");

function waitForStatus(child, expected, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${expected}`)), timeoutMs);
    const onExit = (code) => finish(new Error(`coordinator exited ${code} before ${expected}`));
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value.status === expected || value.status === "needs_reconcile") return finish(null, value);
      }
    };
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(value);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

for (const tampered of [false, true]) test(
  tampered ? "managed close retains the lease when business state changed" :
    "closing a managed coordinator releases only a matching cursor", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-managed-stop-"));
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  const pluginState = path.join(temp, "plugin-state");
  for (const dir of [project, config, pluginState]) fs.mkdirSync(dir);
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const a=process.argv.slice(2);const role=a[2];const project=process.env.FAKE_PROJECT;` +
    `const agent=(r)=>({name:r,agent:r==='ralph'?'claude':'codex',workspace_id:'w1',` +
    `pane_id:r==='ralph'?'w1:p1':'w1:p2',terminal_id:r==='ralph'?'term-r':'term-l',` +
    `cwd:project,interactive_ready:true,agent_status:'idle'});` +
    `if(a[0]==='--version')console.log('herdr 0.9.4');` +
    `else if(a[0]==='integration')console.log('claude: installed\\ncodex: installed');` +
    `else if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:agent(role)}}));` +
    `else if(a[0]==='agent'&&a[1]==='prompt')console.log(JSON.stringify({result:{type:'agent_prompted',agent:agent(role)}}));` +
    `else process.exitCode=2;\n`);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\nconsole.log('{"loggedIn":true}');\n`);
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`);
  for (const file of [fakeHerdr, fakeClaude, fakeCodex]) fs.chmodSync(file, 0o700);
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ project,
    rll_cli_argv: [process.execPath, cli] }));
  const initialized = spawnSync(process.execPath, [cli, "init", "--minimal", project],
    { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  const state = path.join(project, ".dual-agent");
  const identity = JSON.parse(fs.readFileSync(path.join(state, "session.json"), "utf8"));
  const requestId = crypto.randomUUID();
  fs.writeFileSync(path.join(state, "herdr-launch-intent.json"), JSON.stringify({ schema: 1,
    request_id: requestId, project_realpath: fs.realpathSync.native(project),
    session_id: identity.session_id,
    task_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(state, "task.md"))).digest("hex"),
    permission_profile: "interactive", auto_commit: false }));
  fs.writeFileSync(path.join(state, "herdr-launch-workspace.json"), JSON.stringify({ schema: 1,
    request_id: requestId, workspace_id: "w1", root_pane_id: "w1:p1", root_terminal_id: "term-r" }));
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
    CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
    HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: pluginState,
    HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1", workspace_cwd: project }),
    RLL_LAUNCH_REQUEST_ID: requestId, FAKE_PROJECT: project };
  const child = spawn(process.execPath, [coordinator, "start"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await waitForStatus(child, "started");
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, "herdr-launch-result.json"))).status, "started");
    if (tampered) fs.writeFileSync(path.join(state, "work.md"), "Changed after baseline");
    child.kill("SIGTERM");
    const stopped = await waitForStatus(child, tampered ? "needs_reconcile" : "stopped");
    assert.equal(stopped.status, tampered ? "needs_reconcile" : "stopped", JSON.stringify(stopped));
    const sessionDir = path.join(pluginState, "sessions",
      fs.readdirSync(path.join(pluginState, "sessions"))[0]);
    if (tampered) {
      assert.equal(fs.existsSync(path.join(state, "host", "lease")), true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"))).phase,
        "needs_reconcile");
      assert.equal(fs.readdirSync(sessionDir).some((name) => name.startsWith("finished-")), false);
    } else {
      assert.equal(stopped.reason, "managed_pane_closed");
      const snapshot = spawnSync(process.execPath, [cli, "host", "snapshot",
        "--project", project, "--json"], { encoding: "utf8" });
      assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
      assert.equal(JSON.parse(snapshot.stdout).host_state, "unclaimed");
      const finished = fs.readdirSync(sessionDir).find((name) => name.startsWith("finished-"));
      assert.ok(finished);
      assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, finished))).stop_reason,
        "managed_pane_closed");
    }
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("closing a managed pane while Ralph awaits input stops before claiming a lease", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-managed-preclaim-stop-"));
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  const pluginState = path.join(temp, "plugin-state");
  for (const dir of [project, config, pluginState]) fs.mkdirSync(dir);
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  const startedFlag = path.join(temp, "ralph-started");
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const fs=require('node:fs');const a=process.argv.slice(2);` +
    `const project=process.env.FAKE_PROJECT;const started=process.env.FAKE_STARTED_FLAG;` +
    `const pane={workspace_id:'w1',pane_id:'w1:p1',terminal_id:'term-r',cwd:project,` +
    `agent:fs.existsSync(started)?'ralph':null};` +
    `const agent={name:'ralph',agent:'claude',workspace_id:'w1',pane_id:'w1:p1',` +
    `terminal_id:'term-r',cwd:project,interactive_ready:false,agent_status:'blocked'};` +
    `const out=(result)=>console.log(JSON.stringify({result}));` +
    `if(a[0]==='--version')console.log('herdr 0.9.4');` +
    `else if(a[0]==='integration')console.log('claude: installed\\ncodex: installed');` +
    `else if(a[0]==='workspace'&&a[1]==='get')out({workspace:{workspace_id:'w1'}});` +
    `else if(a[0]==='pane'&&a[1]==='get')out({pane});` +
    `else if(a[0]==='agent'&&a[1]==='start'){fs.writeFileSync(started,'1');out({agent});}` +
    `else if(a[0]==='agent'&&a[1]==='get'){if(a[2]==='ralph'&&fs.existsSync(started))out({agent});` +
    `else{console.error(JSON.stringify({error:{code:'agent_not_found'}}));process.exitCode=1;}}` +
    `else process.exitCode=2;\n`);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\nconsole.log('{"loggedIn":true}');\n`);
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`);
  for (const file of [fakeHerdr, fakeClaude, fakeCodex]) fs.chmodSync(file, 0o700);
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ project,
    rll_cli_argv: [process.execPath, cli] }));
  const initialized = spawnSync(process.execPath, [cli, "init", "--minimal", project],
    { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  const state = path.join(project, ".dual-agent");
  const identity = JSON.parse(fs.readFileSync(path.join(state, "session.json"), "utf8"));
  const requestId = crypto.randomUUID();
  fs.writeFileSync(path.join(state, "herdr-launch-intent.json"), JSON.stringify({ schema: 1,
    request_id: requestId, project_realpath: fs.realpathSync.native(project),
    session_id: identity.session_id,
    task_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(state, "task.md"))).digest("hex"),
    permission_profile: "interactive", auto_commit: false }));
  fs.writeFileSync(path.join(state, "herdr-launch-workspace.json"), JSON.stringify({ schema: 1,
    request_id: requestId, workspace_id: "w1", root_pane_id: "w1:p1", root_terminal_id: "term-r" }));
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
    CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
    HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: pluginState,
    HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1", workspace_cwd: project }),
    RLL_LAUNCH_REQUEST_ID: requestId, FAKE_PROJECT: project,
    FAKE_STARTED_FLAG: startedFlag };
  const child = spawn(process.execPath, [coordinator, "start"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const blocked = await waitForStatus(child, "needs_input");
    assert.equal(blocked.role, "ralph");
    child.kill("SIGTERM");
    const stopped = await waitForStatus(child, "needs_reconcile", 5000);
    assert.equal(stopped.code, "MANAGED_PANE_CLOSED_DURING_START");
    const snapshot = spawnSync(process.execPath, [cli, "host", "snapshot",
      "--project", project, "--json"], { encoding: "utf8" });
    assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
    assert.equal(JSON.parse(snapshot.stdout).host_state, "unclaimed");
    assert.equal(JSON.parse(snapshot.stdout).generation, null);
    const sessionDir = path.join(pluginState, "sessions",
      fs.readdirSync(path.join(pluginState, "sessions"))[0]);
    const record = JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json")));
    assert.equal(record.phase, "needs_reconcile");
    assert.equal(record.lease_id, undefined);
    assert.equal(fs.existsSync(path.join(state, "herdr-launch-result.json")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, "herdr-launch-result.json"))).code,
      "MANAGED_PANE_CLOSED_DURING_START");
    assert.equal(fs.readdirSync(sessionDir).some((name) => name.startsWith("initial-")), false);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
