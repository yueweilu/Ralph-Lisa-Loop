import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(root, "../../cli/dist/cli.js");
const coordinator = path.join(root, "coordinator.mjs");

function result(command, args, env) {
  return spawnSync(command, args, { env, encoding: "utf8", timeout: 30000 });
}

function waitForStart(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("coordinator start timeout")), 30000);
    function finish(error, value) {
      clearTimeout(timeout);
      child.stdout.off("data", data);
      child.off("exit", exited);
      if (error) reject(error); else resolve(value);
    }
    function exited(code) { finish(new Error(`coordinator exited: ${code}`)); }
    function data(chunk) {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const value = JSON.parse(line);
        if (value.status === "started" || value.status === "needs_reconcile")
          return finish(null, value);
      }
    }
    child.stdout.on("data", data);
    child.on("exit", exited);
  });
}

test("preclaim pane-busy retry reuses both seats and delivers the task once", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-preclaim-retry-"));
  const project = path.join(temp, "project");
  const configDir = path.join(temp, "config");
  const stateDir = path.join(temp, "state");
  const fakeState = path.join(temp, "herdr-state.json");
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  const busy = path.join(temp, "lisa-busy");
  for (const dir of [project, configDir, stateDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    project, rll_cli_argv: [process.execPath, cli],
  }));
  fs.writeFileSync(fakeState, JSON.stringify({ workspaces: 0, splits: 0, prompts: 0, agents: {} }));
  fs.writeFileSync(busy, "busy");
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const fs=require('node:fs');const a=process.argv.slice(2);` +
    `const file=process.env.FAKE_HERDR_STATE;const s=JSON.parse(fs.readFileSync(file));` +
    `const save=()=>fs.writeFileSync(file,JSON.stringify(s));` +
    `const out=(result)=>console.log(JSON.stringify({result}));` +
    `const pane=(id)=>({workspace_id:'w2',pane_id:id,terminal_id:id==='w2:p1'?'term-ralph':'term-lisa',cwd:process.env.FAKE_PROJECT,agent:id==='w2:p1'&&s.agents.ralph?'ralph':id==='w2:p2'&&s.agents.lisa?'lisa':null});` +
    `if(a[0]==='--version')console.log('herdr 0.9.4');` +
    `else if(a[0]==='integration')console.log('claude: current (v10)\\ncodex: current (v9)');` +
    `else if(a[0]==='workspace'&&a[1]==='create'){s.workspaces++;save();out({workspace:{workspace_id:'w2'},root_pane:pane('w2:p1')});}` +
    `else if(a[0]==='workspace'&&a[1]==='get')out({workspace:{workspace_id:a[2]}});` +
    `else if(a[0]==='pane'&&a[1]==='split'){s.splits++;save();out({pane:pane('w2:p2')});}` +
    `else if(a[0]==='pane'&&a[1]==='get')out({pane:pane(a[2])});` +
    `else if(a[0]==='agent'&&a[1]==='get'){const agent=s.agents[a[2]];if(agent)out({agent});else{console.error(JSON.stringify({error:{code:'agent_not_found'}}));process.exitCode=1;}}` +
    `else if(a[0]==='agent'&&a[1]==='start'){const role=a[2];if(role==='lisa'&&fs.existsSync(process.env.FAKE_LISA_BUSY)){console.error(JSON.stringify({error:{code:'agent_pane_busy'}}));process.exitCode=1;}else{const agent={name:role,agent:a[4],workspace_id:'w2',pane_id:a[6],terminal_id:role==='ralph'?'term-ralph':'term-lisa',cwd:process.env.FAKE_PROJECT,interactive_ready:true,agent_status:'idle'};s.agents[role]=agent;save();out({agent});}}` +
    `else if(a[0]==='agent'&&a[1]==='prompt'){s.prompts++;save();out({type:'agent_prompted',agent:s.agents[a[2]]});}` +
    `else process.exit(2);\n`);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\nconsole.log('{"loggedIn":true}');\n`);
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`);
  for (const file of [fakeHerdr, fakeClaude, fakeCodex]) fs.chmodSync(file, 0o700);
  let child;
  try {
    const init = result(process.execPath, [cli, "init", "--minimal", project]);
    assert.equal(init.status, 0, init.stderr);
    const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
      CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
      HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }),
      FAKE_PROJECT: project, FAKE_HERDR_STATE: fakeState, FAKE_LISA_BUSY: busy };
    const first = result(process.execPath, [coordinator, "start"], env);
    assert.equal(first.status, 7, first.stdout + first.stderr);
    assert.equal(JSON.parse(first.stdout).code, "agent_pane_busy");
    const sessionDir = path.join(stateDir, "sessions",
      fs.readdirSync(path.join(stateDir, "sessions"))[0]);
    const recordPath = path.join(sessionDir, "record.json");
    const failed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(failed.phase, "needs_reconcile");
    assert.equal(failed.lease_id, undefined);
    assert.equal(failed.ralph_terminal_id, "term-ralph");
    assert.equal(failed.lisa_terminal_id, "term-lisa");
    assert.deepEqual(fs.readdirSync(sessionDir), ["record.json"]);
    assert.equal(JSON.parse(fs.readFileSync(fakeState)).prompts, 0);

    const tampered = { ...failed, lisa_terminal_id: "another-terminal" };
    fs.writeFileSync(recordPath, JSON.stringify(tampered));
    const denied = result(process.execPath, [coordinator, "start"], env);
    assert.equal(denied.status, 7, denied.stdout + denied.stderr);
    assert.equal(JSON.parse(denied.stdout).code, "PRECLAIM_PANE_CHANGED");
    fs.writeFileSync(recordPath, JSON.stringify(failed));
    fs.unlinkSync(busy);
    child = spawn(process.execPath, [coordinator, "start"],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    const started = await waitForStart(child);
    assert.equal(started.status, "started", JSON.stringify(started));
    const herdr = JSON.parse(fs.readFileSync(fakeState, "utf8"));
    assert.equal(herdr.workspaces, 1);
    assert.equal(herdr.splits, 1);
    assert.equal(herdr.prompts, 1);
    const snapshot = result(process.execPath,
      [cli, "host", "snapshot", "--project", project, "--json"]);
    assert.equal(JSON.parse(snapshot.stdout).host_state, "claimed");
    const stopped = result(process.execPath, [coordinator, "stop"], env);
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.equal(JSON.parse(fs.readFileSync(fakeState)).prompts, 1);
  } finally {
    child?.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
