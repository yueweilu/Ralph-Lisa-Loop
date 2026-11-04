import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(root, "../../cli/dist/cli.js");
const coordinator = path.join(root, "coordinator.mjs");

function waitForLine(child, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("coordinator output timeout")), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(value);
    }
    function onExit(code) { finish(new Error(`coordinator exited before output: ${code}`)); }
    function onData(chunk) {
      buffer += chunk.toString();
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const value = JSON.parse(line);
        if (predicate(value)) return finish(null, value);
      }
    }
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

test("coordinator claims and binds observed seats, heartbeats, then releases on stop", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-coordinator-"));
  const project = path.join(temp, "project");
  const configDir = path.join(temp, "config");
  const stateDir = path.join(temp, "state");
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  const prompts = path.join(temp, "prompts.jsonl");
  const busyFile = path.join(temp, "lisa-busy");
  fs.mkdirSync(project);
  fs.mkdirSync(configDir);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(configDir + "/settings.json", JSON.stringify({
    project, rll_cli_argv: [process.execPath, cli],
  }));
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const a=process.argv.slice(2);\n` +
    `if(a[0]==='--version') console.log('herdr 0.9.4');\n` +
    `else if(a[0]==='integration') console.log('claude: not installed\\ncodex: not installed');\n` +
    `else if(a[0]==='agent'&&a[1]==='get'){const role=a[2];console.log(JSON.stringify({result:{agent:{name:role,agent:role==='ralph'?'claude':'codex',workspace_id:'w1',pane_id:role==='ralph'?'w1:p1':'w1:p2',cwd:process.env.FAKE_PROJECT,interactive_ready:true,agent_status:role==='lisa'&&require('node:fs').existsSync(process.env.FAKE_BUSY_FILE)?'working':'idle'}}}));}\n` +
    `else if(a[0]==='agent'&&a[1]==='prompt'){const role=a[2];require('node:fs').appendFileSync(process.env.FAKE_PROMPTS,JSON.stringify({role,message:a[3]})+'\\n');console.log(JSON.stringify({result:{type:'agent_prompted',agent:{name:role,agent:role==='ralph'?'claude':'codex',workspace_id:'w1',pane_id:role==='ralph'?'w1:p1':'w1:p2',cwd:process.env.FAKE_PROJECT,agent_status:'working'}}}));}\n` +
    `else process.exit(2);\n`);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\nconsole.log('{"loggedIn":true}');\n`);
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`);
  for (const file of [fakeHerdr, fakeClaude, fakeCodex]) fs.chmodSync(file, 0o700);
  const init = spawnSync(process.execPath, [cli, "init", "--minimal", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const before = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
    encoding: "utf8",
  }).stdout);
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
    CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
    HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }),
    FAKE_PROJECT: project, FAKE_PROMPTS: prompts, FAKE_BUSY_FILE: busyFile };
  const child = spawn(process.execPath, [coordinator, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let laterOutput = "";
  child.stdout.on("data", (chunk) => { laterOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { laterOutput += chunk.toString(); });
  try {
    const started = await waitForLine(child, (value) => value.status === "started" || value.status === "needs_reconcile");
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.equal(fs.readFileSync(prompts, "utf8").trim().split("\n").length, 1);
    assert.match(JSON.parse(fs.readFileSync(prompts, "utf8").trim()).message, /task\.md/);
    const claimed = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
      encoding: "utf8",
    }).stdout);
    assert.equal(claimed.host_state, "claimed");
    assert.equal(claimed.binding_state, "bound");
    assert.equal(claimed.seats.ralph.pane_id, "w1:p1");
    assert.equal(claimed.seats.lisa.pane_id, "w1:p2");
    assert.equal(claimed.state_digest, before.state_digest);
    const duplicate = spawnSync(process.execPath, [coordinator, "start"], { env, encoding: "utf8" });
    assert.equal(duplicate.status, 3);
    assert.equal(JSON.parse(duplicate.stdout).code, "HOST_ALREADY_CLAIMED");
    const paused = spawnSync(process.execPath, [coordinator, "pause"],
      { env, encoding: "utf8", timeout: 15000 });
    assert.equal(paused.status, 0, paused.stdout + paused.stderr);
    assert.equal(JSON.parse(paused.stdout).status, "paused");
    const actionStatus = () => JSON.parse(spawnSync(process.execPath,
      [path.join(root, "actions.mjs"), "status"], { env, encoding: "utf8" }).stdout);
    assert.equal(actionStatus().coordination.phase, "paused");
    assert.equal(actionStatus().coordination.initial_status, "accepted");
    fs.writeFileSync(busyFile, "busy");
    const tooEarly = spawnSync(process.execPath, [coordinator, "resume"],
      { env, encoding: "utf8", timeout: 15000 });
    assert.equal(tooEarly.status, 4, tooEarly.stdout + tooEarly.stderr);
    assert.equal(JSON.parse(tooEarly.stdout).code, "AGENT_NOT_READY");
    assert.equal(actionStatus().coordination.phase, "paused");
    fs.unlinkSync(busyFile);
    const resumed = spawnSync(process.execPath, [coordinator, "resume"],
      { env, encoding: "utf8", timeout: 15000 });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, "active");
    assert.equal(actionStatus().coordination.phase, "active");
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const lease = JSON.parse(fs.readFileSync(path.join(project, ".dual-agent", "host", "lease", "record.json")));
    assert.ok(lease.heartbeat_seq >= 1);
    const host = (action, args = []) => {
      const result = spawnSync(process.execPath, [cli, "host", action, "--project", project,
        ...args, "--json"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    const promptRows = () => fs.existsSync(prompts)
      ? fs.readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    async function waitForPrompts(count) {
      for (let i = 0; i < 40; i++) {
        if (promptRows().length >= count) return promptRows();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const pluginDir = path.join(stateDir, "sessions");
      const sessionDir = fs.existsSync(pluginDir) ? path.join(pluginDir, fs.readdirSync(pluginDir)[0]) : null;
      const record = sessionDir ? fs.readFileSync(path.join(sessionDir, "record.json"), "utf8") : "missing";
      assert.fail(`expected ${count} Herdr prompts, got ${promptRows().length}; record=${record}; output=${laterOutput}`);
    }
    function submit(role, generation, content) {
      const candidateId = randomUUID();
      const requestId = randomUUID();
      const filename = `candidate-${generation}.md`;
      fs.writeFileSync(path.join(project, filename), content);
      host("propose", ["--role", role, "--file", filename, "--candidate-id", candidateId]);
      const args = ["--lease-id", started.lease_id, "--request-id", requestId,
        "--candidate-id", candidateId, "--expected-generation", String(generation),
        "--expected-binding-generation", String(started.binding_generation)];
      const checked = host("commit-check", args);
      assert.equal(checked.status, "awaiting_source_confirmation");
      host("confirm-candidate", [...args, "--expected-content-sha256", checked.content_sha256,
        "--decision", "reviewed_candidate_source"]);
      const receipt = host("commit", args);
      assert.equal(receipt.status, "committed");
      return receipt;
    }
    const first = submit("ralph", 0, "[PLAN] Define the change.\n\nTest Plan: npm test\n");
    assert.equal((await waitForPrompts(2))[1].role, "lisa");
    assert.equal(host("receipt", ["--request-id", first.request_id]).request_id, first.request_id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(promptRows().length, 2, "polling must not replay a committed receipt");
    const second = submit("lisa", 1,
      "[NEEDS_WORK] Cover the missing case.\n\n- Issue at commands.ts:42 needs another check.\n");
    const rows = await waitForPrompts(3);
    assert.deepEqual(rows.map((row) => row.role), ["ralph", "lisa", "ralph"]);
    assert.match(rows[1].message, new RegExp(first.request_id));
    assert.match(rows[2].message, new RegExp(second.request_id));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(promptRows().length, 3);
    const pluginDir = path.join(stateDir, "sessions");
    const sessionDir = path.join(pluginDir, fs.readdirSync(pluginDir)[0]);
    const initial = JSON.parse(fs.readFileSync(path.join(sessionDir,
      `initial-${claimed.session_id}.json`), "utf8"));
    assert.equal(initial.status, "accepted");
    assert.equal(initial.role, "ralph");
    for (const receipt of [first, second]) {
      const delivery = JSON.parse(fs.readFileSync(path.join(sessionDir,
        `delivery-${receipt.request_id}.json`), "utf8"));
      assert.equal(delivery.status, "accepted");
      assert.equal(delivery.generation, receipt.generation_after);
    }
    const stopped = spawnSync(process.execPath, [coordinator, "stop"], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).status, "stopped");
    const released = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
      encoding: "utf8",
    }).stdout);
    assert.equal(released.host_state, "unclaimed");
    assert.equal(released.binding_state, "stale");
    assert.equal(released.state_digest, second.state_digest_after);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("start creates both seats and waits for a blocked agent before claiming", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-auto-seats-"));
  const project = path.join(temp, "project");
  const configDir = path.join(temp, "config");
  const stateDir = path.join(temp, "state");
  const fakeState = path.join(temp, "herdr-state.json");
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  for (const dir of [project, configDir, stateDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    project, rll_cli_argv: [process.execPath, cli],
  }));
  fs.writeFileSync(fakeState, JSON.stringify({ workspaces: 0, agents: {} }));
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const fs=require('node:fs');const a=process.argv.slice(2);` +
    `const file=process.env.FAKE_HERDR_STATE;const s=JSON.parse(fs.readFileSync(file));` +
    `const save=()=>fs.writeFileSync(file,JSON.stringify(s));` +
    `const out=(result)=>console.log(JSON.stringify({result}));` +
    `if(a[0]==='--version') console.log('herdr 0.9.4');` +
    `else if(a[0]==='integration') console.log('claude: current (v10)\\ncodex: current (v9)');` +
    `else if(a[0]==='agent'&&a[1]==='get'){const agent=s.agents[a[2]];` +
      `if(agent?.agent_status==='blocked'){s.blocked_reads=(s.blocked_reads||0)+1;if(s.blocked_reads>1){agent.agent_status='idle';agent.interactive_ready=true;}save();}` +
      `if(!agent){console.error(JSON.stringify({error:{code:'agent_not_found'}}));process.exitCode=1;}else out({agent});}` +
    `else if(a[0]==='workspace'&&a[1]==='create'){s.workspaces++;save();` +
      `out({workspace:{workspace_id:'w2'},root_pane:{workspace_id:'w2',pane_id:'w2:p1'}});}` +
    `else if(a[0]==='pane'&&a[1]==='split')out({pane:{workspace_id:'w2',pane_id:'w2:p2'}});` +
    `else if(a[0]==='agent'&&a[1]==='start'){const role=a[2];` +
      `const agent={name:role,agent:a[4],workspace_id:'w2',pane_id:a[6],cwd:process.env.FAKE_PROJECT,interactive_ready:role==='ralph',agent_status:role==='ralph'?'idle':'blocked'};` +
      `s.agents[role]=agent;save();if(role==='lisa'){console.error(JSON.stringify({error:{code:'agent_not_ready'}}));process.exitCode=1;}else out({agent});}` +
    `else if(a[0]==='agent'&&a[1]==='prompt'){const agent=s.agents[a[2]];s.prompts=(s.prompts||0)+1;save();out({type:'agent_prompted',agent});}` +
    `else process.exit(2);\n`);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\nconsole.log('{"loggedIn":true}');\n`);
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`);
  for (const file of [fakeHerdr, fakeClaude, fakeCodex]) fs.chmodSync(file, 0o700);
  const init = spawnSync(process.execPath, [cli, "init", "--minimal", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const before = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
    encoding: "utf8",
  }).stdout);
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
    CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
    HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }),
    FAKE_PROJECT: project, FAKE_HERDR_STATE: fakeState };
  const child = spawn(process.execPath, [coordinator, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await waitForLine(child, (value) => value.status === "started" || value.status === "needs_reconcile");
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.equal(started.workspace_id, "w2");
    const herdrState = JSON.parse(fs.readFileSync(fakeState, "utf8"));
    assert.equal(herdrState.workspaces, 1);
    assert.equal(herdrState.agents.ralph.pane_id, "w2:p1");
    assert.equal(herdrState.agents.lisa.pane_id, "w2:p2");
    assert.equal(herdrState.prompts, 1);
    const claimed = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
      encoding: "utf8",
    }).stdout);
    assert.equal(claimed.host_state, "claimed");
    assert.equal(claimed.workspace_id, "w2");
    assert.equal(claimed.state_digest, before.state_digest);
    const paused = spawnSync(process.execPath, [coordinator, "pause"],
      { env, encoding: "utf8", timeout: 15000 });
    assert.equal(paused.status, 0, paused.stdout + paused.stderr);
    assert.equal(JSON.parse(paused.stdout).status, "paused");
    const stopped = spawnSync(process.execPath, [coordinator, "stop"], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).status, "stopped");
    const released = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
      encoding: "utf8",
    }).stdout);
    assert.equal(released.host_state, "unclaimed");
    assert.equal(released.state_digest, before.state_digest);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fakeState, "utf8")).agents), ["ralph", "lisa"]);
    const retryEnv = { ...env, HERDR_PLUGIN_CONTEXT_JSON:
      JSON.stringify({ workspace_id: "w2", workspace_cwd: project }) };
    const retry = spawnSync(process.execPath, [coordinator, "start"],
      { env: retryEnv, encoding: "utf8" });
    assert.equal(retry.status, 3, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).code, "INITIAL_PROMPT_REQUIRES_RECOVERY");
    assert.equal(JSON.parse(fs.readFileSync(fakeState, "utf8")).prompts, 1);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

for (const failure of ["initial-timeout", "timeout", "wrong-pane", "paused-commit"]) test(
  `${failure} Herdr prompt keeps one durable intent and stops without replay`, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-uncertain-"));
  const project = path.join(temp, "project");
  const configDir = path.join(temp, "config");
  const stateDir = path.join(temp, "state");
  const prompts = path.join(temp, "prompts.txt");
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  for (const dir of [project, configDir, stateDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    project, rll_cli_argv: [process.execPath, cli],
  }));
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const a=process.argv.slice(2);` +
    `if(a[0]==='--version')console.log('herdr 0.9.4');` +
    `else if(a[0]==='integration')console.log('claude: current (v10)\\ncodex: current (v9)');` +
    `else if(a[0]==='agent'&&a[1]==='get'){const role=a[2];console.log(JSON.stringify({result:{agent:{name:role,agent:role==='ralph'?'claude':'codex',workspace_id:'w1',pane_id:role==='ralph'?'w1:p1':'w1:p2',cwd:process.env.FAKE_PROJECT,interactive_ready:true,agent_status:'idle'}}}));}` +
    `else if(a[0]==='agent'&&a[1]==='prompt'){require('node:fs').appendFileSync(process.env.FAKE_PROMPTS,a[2]+'\\n');if((a[2]==='ralph'&&process.env.FAKE_PROMPT_FAILURE==='initial-timeout')||(a[2]==='lisa'&&process.env.FAKE_PROMPT_FAILURE==='timeout')){console.error(JSON.stringify({error:{code:'timeout'}}));process.exitCode=1;}else if(a[2]==='ralph')console.log(JSON.stringify({result:{type:'agent_prompted',agent:{name:'ralph',agent:'claude',workspace_id:'w1',pane_id:'w1:p1',cwd:process.env.FAKE_PROJECT}}}));else console.log(JSON.stringify({result:{type:'agent_prompted',agent:{name:a[2],agent:'codex',workspace_id:'w1',pane_id:'w1:p9',cwd:process.env.FAKE_PROJECT}}}));}` +
    `else process.exitCode=2;\n`);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\nconsole.log('{"loggedIn":true}');\n`);
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`);
  for (const file of [fakeHerdr, fakeClaude, fakeCodex]) fs.chmodSync(file, 0o700);
  const init = spawnSync(process.execPath, [cli, "init", "--minimal", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
    CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
    HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }),
    FAKE_PROJECT: project, FAKE_PROMPTS: prompts, FAKE_PROMPT_FAILURE: failure };
  const child = spawn(process.execPath, [coordinator, "start"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await waitForLine(child, (value) =>
      value.status === "started" || value.status === "needs_reconcile");
    if (failure === "initial-timeout") {
      assert.equal(started.status, "needs_reconcile");
      assert.equal(started.code, "timeout");
      const sessionDir = path.join(stateDir, "sessions",
        fs.readdirSync(path.join(stateDir, "sessions"))[0]);
      const record = JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"), "utf8"));
      const initial = JSON.parse(fs.readFileSync(path.join(sessionDir,
        `initial-${record.session_id}.json`), "utf8"));
      assert.equal(initial.status, "intent");
      assert.equal(initial.role, "ralph");
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      const duplicate = spawnSync(process.execPath, [coordinator, "start"],
        { env, encoding: "utf8" });
      assert.equal(duplicate.status, 3);
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      return;
    }
    assert.equal(started.status, "started");
    if (failure === "paused-commit") {
      const paused = spawnSync(process.execPath, [coordinator, "pause"],
        { env, encoding: "utf8", timeout: 15000 });
      assert.equal(paused.status, 0, paused.stdout + paused.stderr);
      assert.equal(JSON.parse(paused.stdout).status, "paused");
    }
    const host = (action, args = []) => {
      const result = spawnSync(process.execPath, [cli, "host", action,
        "--project", project, ...args, "--json"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    const candidateId = randomUUID();
    const requestId = randomUUID();
    fs.writeFileSync(path.join(project, "candidate.md"),
      "[PLAN] Define the change.\n\nTest Plan: npm test\n");
    host("propose", ["--role", "ralph", "--file", "candidate.md", "--candidate-id", candidateId]);
    const args = ["--lease-id", started.lease_id, "--request-id", requestId,
      "--candidate-id", candidateId, "--expected-generation", "0",
      "--expected-binding-generation", String(started.binding_generation)];
    const checked = host("commit-check", args);
    host("confirm-candidate", [...args, "--expected-content-sha256", checked.content_sha256,
      "--decision", "reviewed_candidate_source"]);
    host("commit", args);
    const sessionDir = path.join(stateDir, "sessions", fs.readdirSync(path.join(stateDir, "sessions"))[0]);
    if (failure === "paused-commit") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n",
        "paused coordinator must not prompt after the initial task");
      const resume = spawnSync(process.execPath, [coordinator, "resume"],
        { env, encoding: "utf8", timeout: 15000 });
      assert.equal(resume.status, 7, resume.stdout + resume.stderr);
      const record = JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"), "utf8"));
      assert.equal(record.phase, "needs_reconcile");
      assert.equal(record.error, "RESUME_STATE_CHANGED");
      assert.equal(host("snapshot").host_state, "claimed");
      return;
    }
    let record;
    for (let i = 0; i < 40; i++) {
      record = JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"), "utf8"));
      if (record.phase === "needs_reconcile") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(record.phase, "needs_reconcile");
    assert.equal(record.error, failure === "timeout" ? "timeout" : "PROMPT_ACK_MISMATCH");
    const delivery = JSON.parse(fs.readFileSync(path.join(sessionDir,
      `delivery-${requestId}.json`), "utf8"));
    assert.equal(delivery.status, "intent");
    assert.equal(delivery.role, "lisa");
    assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\nlisa\n");
    const stopped = spawnSync(process.execPath, [coordinator, "stop"], { env, encoding: "utf8" });
    assert.equal(stopped.status, 7);
    assert.equal(host("snapshot").host_state, "claimed");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
