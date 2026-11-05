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
    `else if(a[0]==='agent'&&a[1]==='get'){const role=a[2];const prompts=require('node:fs').existsSync(process.env.FAKE_PROMPTS)?require('node:fs').readFileSync(process.env.FAKE_PROMPTS,'utf8'):'';const hasLisaSession=prompts.includes('"role":"lisa"');const agent=role==='ralph'?'claude':'codex';console.log(JSON.stringify({result:{agent:{name:role,agent,workspace_id:'w1',pane_id:role==='ralph'?'w1:p1':'w1:p2',terminal_id:role==='ralph'?(process.env.FAKE_RALPH_TERMINAL||'term-r'):'term-l',cwd:process.env.FAKE_PROJECT,agent_session:role==='ralph'||hasLisaSession?{agent,kind:'id',source:'herdr:'+agent,value:role==='ralph'?(process.env.FAKE_RALPH_SESSION||'session-123'):'lisa-session-123'}:undefined,interactive_ready:true,agent_status:role==='lisa'&&require('node:fs').existsSync(process.env.FAKE_BUSY_FILE)?'working':'idle'}}}));}\n` +
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
  const runWithHostBusyRetry = async (args, options = { env }) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = spawnSync(process.execPath, args,
        { encoding: "utf8", ...options });
      let value;
      try { value = JSON.parse(result.stdout); } catch { /* Keep the original result. */ }
      if (!["HOST_BUSY", "RECOVERY_STATE_CHANGED"].includes(value?.code)) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`command stayed HOST_BUSY after bounded retries: ${args.slice(1, 3).join(" ")}`);
  };
  const child = spawn(process.execPath, [coordinator, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let laterOutput = "";
  child.stdout.on("data", (chunk) => { laterOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { laterOutput += chunk.toString(); });
  try {
    const started = await waitForLine(child, (value) => value.status === "started" || value.status === "needs_reconcile");
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.equal(fs.readFileSync(prompts, "utf8").trim().split("\n").length, 1);
    assert.match(JSON.parse(fs.readFileSync(prompts, "utf8").trim()).message, /task\.md/);
    const recovery = await runWithHostBusyRetry([path.join(root, "actions.mjs"), "recovery-check"]);
    assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
    const audited = JSON.parse(recovery.stdout);
    assert.equal(audited.status, "review_required");
    assert.equal(audited.cli.lease_id, started.lease_id);
    assert.equal(audited.plugin.phase, "active");
    assert.equal(audited.plugin.initial_status, "accepted");
    assert.equal(audited.coordinator_process, "pid_exists");
    assert.ok(audited.continuation_blockers.includes("COORDINATOR_PID_PRESENT"));
    assert.ok(audited.continuation_blockers.includes("SEAT_REBIND_REQUIRED"));
    assert.equal(audited.continuation_blockers.includes("CURSOR_STATE_MISMATCH"), false);
    assert.equal(audited.continuation_blockers.includes("DELIVERY_RECORD_MISSING"), false);
    assert.deepEqual(audited.deliveries.map((row) => [row.kind, row.status]),
      [["initial", "accepted"]]);
    assert.equal(audited.seats.ralph.observation, "matches_binding");
    assert.equal(audited.seats.ralph.native_session.status, "present");
    assert.match(audited.seats.ralph.native_session.fingerprint_sha256, /^[0-9a-f]{64}$/);
    assert.equal(audited.seats.ralph.native_session.continuity, "matches_record");
    assert.equal(audited.seats.lisa.native_session.status, "missing");
    assert.equal(audited.seats.lisa.native_session.continuity, "not_recorded");
    assert.equal(audited.restart_observation, "manual_rebind_required");
    assert.doesNotMatch(recovery.stdout, /session-123/);
    const changedSession = await runWithHostBusyRetry(
      [path.join(root, "actions.mjs"), "recovery-check"],
      { env: { ...env, FAKE_RALPH_SESSION: "replacement-session" } });
    assert.equal(changedSession.status, 0, changedSession.stdout + changedSession.stderr);
    const changedAudit = JSON.parse(changedSession.stdout);
    assert.equal(changedAudit.seats.ralph.observation, "matches_binding");
    assert.equal(changedAudit.seats.ralph.native_session.continuity, "changed_or_missing");
    assert.equal(changedAudit.restart_observation, "manual_rebind_required");
    assert.ok(changedAudit.continuation_blockers.includes("SEAT_REBIND_REQUIRED"));
    const claimed = JSON.parse((await runWithHostBusyRetry(
      [cli, "host", "snapshot", "--project", project, "--json"])).stdout);
    assert.equal(claimed.host_state, "claimed");
    assert.equal(claimed.binding_state, "bound");
    assert.equal(claimed.seats.ralph.pane_id, "w1:p1");
    assert.equal(claimed.seats.lisa.pane_id, "w1:p2");
    assert.equal(claimed.state_digest, before.state_digest);
    const sessionDir = path.join(stateDir, "sessions",
      fs.readdirSync(path.join(stateDir, "sessions"))[0]);
    const boundRecord = JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"), "utf8"));
    assert.equal(boundRecord.plan.seats.ralph.native_session_fingerprint_sha256,
      audited.seats.ralph.native_session.fingerprint_sha256);
    assert.equal(boundRecord.plan.seats.lisa.native_session_fingerprint_sha256, null);
    const duplicate = await runWithHostBusyRetry([coordinator, "start"]);
    assert.equal(duplicate.status, 3);
    assert.equal(JSON.parse(duplicate.stdout).code, "HOST_ALREADY_CLAIMED");
    const paused = await runWithHostBusyRetry([coordinator, "pause"], { env, timeout: 15000 });
    assert.equal(paused.status, 0, paused.stdout + paused.stderr);
    assert.equal(JSON.parse(paused.stdout).status, "paused");
    const actionStatus = () => JSON.parse(spawnSync(process.execPath,
      [path.join(root, "actions.mjs"), "status"], { env, encoding: "utf8" }).stdout);
    async function stableActionStatus() {
      for (let attempt = 0; attempt < 20; attempt++) {
        const value = actionStatus();
        if (value.coordination) return value;
        assert.equal(value.code, "HOST_BUSY", JSON.stringify(value));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("status stayed busy after bounded retries");
    }
    assert.equal((await stableActionStatus()).coordination.phase, "paused");
    assert.equal((await stableActionStatus()).coordination.initial_status, "accepted");
    fs.writeFileSync(busyFile, "busy");
    const tooEarly = await runWithHostBusyRetry([coordinator, "resume"], { env, timeout: 15000 });
    assert.equal(tooEarly.status, 4, tooEarly.stdout + tooEarly.stderr);
    assert.equal(JSON.parse(tooEarly.stdout).code, "AGENT_NOT_READY");
    assert.equal((await stableActionStatus()).coordination.phase, "paused");
    fs.unlinkSync(busyFile);
    const resumed = await runWithHostBusyRetry([coordinator, "resume"], { env, timeout: 15000 });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, "active");
    assert.equal((await stableActionStatus()).coordination.phase, "active");
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const lease = JSON.parse(fs.readFileSync(path.join(project, ".dual-agent", "host", "lease", "record.json")));
    assert.ok(lease.heartbeat_seq >= 1);
    const host = async (action, args = []) => {
      const result = await runWithHostBusyRetry([cli, "host", action, "--project", project,
        ...args, "--json"]);
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
    async function submit(role, generation, content) {
      const candidateId = randomUUID();
      const requestId = randomUUID();
      const filename = `candidate-${generation}.md`;
      fs.writeFileSync(path.join(project, filename), content);
      await host("propose", ["--role", role, "--file", filename, "--candidate-id", candidateId]);
      const args = ["--lease-id", started.lease_id, "--request-id", requestId,
        "--candidate-id", candidateId, "--expected-generation", String(generation),
        "--expected-binding-generation", String(started.binding_generation)];
      const checked = await host("commit-check", args);
      assert.equal(checked.status, "awaiting_source_confirmation");
      await host("confirm-candidate", [...args, "--expected-content-sha256", checked.content_sha256,
        "--decision", "reviewed_candidate_source"]);
      const receipt = await host("commit", args);
      assert.equal(receipt.status, "committed");
      return receipt;
    }
    const first = await submit("ralph", 0, "[PLAN] Define the change.\n\nTest Plan: npm test\n");
    assert.equal((await waitForPrompts(2))[1].role, "lisa");
    assert.equal((await host("receipt", ["--request-id", first.request_id])).request_id, first.request_id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(promptRows().length, 2, "polling must not replay a committed receipt");
    const second = await submit("lisa", 1,
      "[NEEDS_WORK] Cover the missing case.\n\n- Issue at commands.ts:42 needs another check.\n");
    const rows = await waitForPrompts(3);
    assert.deepEqual(rows.map((row) => row.role), ["ralph", "lisa", "ralph"]);
    assert.match(rows[1].message, new RegExp(first.request_id));
    assert.match(rows[2].message, new RegExp(second.request_id));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(promptRows().length, 3);
    const pluginDir = path.join(stateDir, "sessions");
    const sessionDirAfterHandoff = path.join(pluginDir, fs.readdirSync(pluginDir)[0]);
    const initial = JSON.parse(fs.readFileSync(path.join(sessionDirAfterHandoff,
      `initial-${claimed.session_id}.json`), "utf8"));
    assert.equal(initial.status, "accepted");
    assert.equal(initial.role, "ralph");
    for (const receipt of [first, second]) {
      const delivery = JSON.parse(fs.readFileSync(path.join(sessionDirAfterHandoff,
        `delivery-${receipt.request_id}.json`), "utf8"));
      assert.equal(delivery.status, "accepted");
      assert.equal(delivery.generation, receipt.generation_after);
    }
    const boundAfterHandoff = JSON.parse(fs.readFileSync(path.join(sessionDirAfterHandoff,
      "record.json"), "utf8"));
    assert.match(boundAfterHandoff.plan.seats.lisa.native_session_fingerprint_sha256,
      /^[0-9a-f]{64}$/);
    const stopped = await runWithHostBusyRetry([coordinator, "stop"], { env, timeout: 15000 });
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).status, "stopped");
    const released = JSON.parse((await runWithHostBusyRetry(
      [cli, "host", "snapshot", "--project", project, "--json"])).stdout);
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
      `const agent={name:role,agent:a[4],workspace_id:'w2',pane_id:a[6],terminal_id:'term-'+role,cwd:process.env.FAKE_PROJECT,interactive_ready:role==='ralph',agent_status:role==='ralph'?'idle':'blocked'};` +
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

for (const failure of ["initial-timeout", "timeout", "wrong-pane", "paused-commit",
  "server-restart", "server-restart-bind-failure", "server-restart-continue",
  "server-restart-continue-failure", "server-restart-continue-uncertain"]) test(
  `${failure} Herdr prompt keeps one durable intent and stops without replay`, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-uncertain-"));
  const project = path.join(temp, "project");
  const configDir = path.join(temp, "config");
  const stateDir = path.join(temp, "state");
  const prompts = path.join(temp, "prompts.txt");
  const restartedFile = path.join(temp, "server-restarted");
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
    `else if(a[0]==='agent'&&a[1]==='get'){const role=a[2];const fs=require('node:fs');const changed=fs.existsSync(process.env.FAKE_SERVER_RESTARTED);const marker=process.env.FAKE_AUDIT_MUTATION;if(role==='ralph'&&marker&&fs.existsSync(marker)){const target=fs.readFileSync(marker,'utf8').trim()==='lease'?process.env.FAKE_LEASE_PATH:process.env.FAKE_RECORD_PATH;const value=JSON.parse(fs.readFileSync(target,'utf8'));if(target===process.env.FAKE_LEASE_PATH)value.heartbeat_seq++;else value.error='changed-during-audit';fs.writeFileSync(target,JSON.stringify(value));fs.unlinkSync(marker);}const rebindMarker=process.env.FAKE_REBIND_MARKER;const continuationMarker=process.env.FAKE_CONTINUATION_MARKER;const fail=(rebindMarker&&fs.existsSync(rebindMarker)&&JSON.parse(fs.readFileSync(rebindMarker,'utf8')).status==='claimed')||(continuationMarker&&fs.existsSync(continuationMarker));console.log(JSON.stringify({result:{agent:{name:role,agent:role==='ralph'?'claude':'codex',workspace_id:'w1',pane_id:role==='ralph'?'w1:p1':'w1:p2',terminal_id:(fail?'bad-':changed?'new-':'term-')+role,cwd:process.env.FAKE_PROJECT,agent_session:role==='ralph'?{agent:'claude',kind:'id',source:'herdr:claude',value:process.env.FAKE_RALPH_SESSION||'ralph-session-1'}:undefined,interactive_ready:true,agent_status:'idle'}}}));}` +
    `else if(a[0]==='agent'&&a[1]==='prompt'){require('node:fs').appendFileSync(process.env.FAKE_PROMPTS,a[2]+'\\n');if((a[2]==='ralph'&&process.env.FAKE_PROMPT_FAILURE==='initial-timeout')||(a[2]==='lisa'&&process.env.FAKE_PROMPT_FAILURE==='timeout')){console.error(JSON.stringify({error:{code:'timeout'}}));process.exitCode=1;}else if(a[2]==='ralph')console.log(JSON.stringify({result:{type:'agent_prompted',agent:{name:'ralph',agent:'claude',workspace_id:'w1',pane_id:'w1:p1',cwd:process.env.FAKE_PROJECT}}}));else console.log(JSON.stringify({result:{type:'agent_prompted',agent:{name:a[2],agent:'codex',workspace_id:'w1',pane_id:process.env.FAKE_PROMPT_FAILURE==='server-restart-continue'?'w1:p2':'w1:p9',cwd:process.env.FAKE_PROJECT}}}));}` +
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
    FAKE_PROJECT: project, FAKE_PROMPTS: prompts, FAKE_PROMPT_FAILURE: failure,
    FAKE_SERVER_RESTARTED: restartedFile };
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
      const recovery = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "recovery-check"], { env, encoding: "utf8" });
      assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
      const audited = JSON.parse(recovery.stdout);
      assert.equal(audited.plugin_warning, "DELIVERY_OUTCOME_UNCERTAIN");
      assert.equal(audited.plugin.phase, "needs_reconcile");
      assert.ok(audited.continuation_blockers.includes("DELIVERY_OUTCOME_UNCERTAIN"));
      assert.deepEqual(audited.deliveries.map((row) => [row.kind, row.status]),
        [["initial", "intent"]]);
      const recordFile = path.join(sessionDir, "record.json");
      const initialFile = path.join(sessionDir, `initial-${record.session_id}.json`);
      const originalInitial = fs.readFileSync(initialFile, "utf8");
      const audit = () => spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "recovery-check"], { env, encoding: "utf8" });
      fs.unlinkSync(initialFile);
      const missingDelivery = audit();
      assert.equal(missingDelivery.status, 0, missingDelivery.stdout + missingDelivery.stderr);
      assert.ok(JSON.parse(missingDelivery.stdout).continuation_blockers.includes("DELIVERY_RECORD_MISSING"));
      fs.writeFileSync(initialFile, originalInitial);
      fs.writeFileSync(recordFile, JSON.stringify({ ...record, cursor_generation: 3 }));
      const wrongCursor = audit();
      assert.equal(wrongCursor.status, 0, wrongCursor.stdout + wrongCursor.stderr);
      assert.ok(JSON.parse(wrongCursor.stdout).continuation_blockers.includes("CURSOR_STATE_MISMATCH"));
      fs.writeFileSync(recordFile, JSON.stringify(record));
      const controlFile = path.join(sessionDir, "control.json");
      fs.writeFileSync(controlFile, "pending");
      const pendingControl = audit();
      assert.equal(pendingControl.status, 0, pendingControl.stdout + pendingControl.stderr);
      assert.ok(JSON.parse(pendingControl.stdout).continuation_blockers.includes("CONTROL_PENDING"));
      fs.unlinkSync(controlFile);
      const mutationMarker = path.join(temp, "audit-mutation");
      const leaseFile = path.join(project, ".dual-agent", "host", "lease", "record.json");
      for (const [mutation, target] of [["plugin", recordFile], ["lease", leaseFile]]) {
        const original = fs.readFileSync(target, "utf8");
        fs.writeFileSync(mutationMarker, mutation);
        const changedDuringAudit = spawnSync(process.execPath,
          [path.join(root, "actions.mjs"), "recovery-check"], {
            env: { ...env, FAKE_AUDIT_MUTATION: mutationMarker,
              FAKE_RECORD_PATH: recordFile, FAKE_LEASE_PATH: leaseFile }, encoding: "utf8",
          });
        assert.equal(changedDuringAudit.status, 7,
          changedDuringAudit.stdout + changedDuringAudit.stderr);
        assert.equal(JSON.parse(changedDuringAudit.stdout).code, "RECOVERY_STATE_CHANGED");
        assert.equal(fs.existsSync(mutationMarker), false);
        fs.writeFileSync(target, original);
      }
      for (const change of [
        { pane_id: "w1:other" }, { workspace_id: "other" },
        { message_sha256: "not-a-hash" }, { role: "lisa" },
      ]) {
        fs.writeFileSync(initialFile, JSON.stringify({ ...initial, ...change }));
        const mismatched = audit();
        assert.equal(mismatched.status, 7, mismatched.stdout + mismatched.stderr);
        assert.equal(JSON.parse(mismatched.stdout).code, "PLUGIN_DELIVERY_INVALID");
      }
      fs.writeFileSync(initialFile, originalInitial);
      fs.writeFileSync(recordFile, JSON.stringify({ ...record,
        binding_generation: record.binding_generation + 1 }));
      const wrongBinding = audit();
      assert.equal(wrongBinding.status, 7, wrongBinding.stdout + wrongBinding.stderr);
      assert.equal(JSON.parse(wrongBinding.stdout).code, "PLUGIN_BINDING_MISMATCH");
      fs.writeFileSync(recordFile, JSON.stringify(record));
      fs.writeFileSync(recordFile, JSON.stringify({ ...record, plan: {
        ...record.plan, seats: { ...record.plan.seats,
          ralph: { ...record.plan.seats.ralph, pane_id: "w1:other" } },
      } }));
      fs.writeFileSync(initialFile, JSON.stringify({ ...initial, pane_id: "w1:other" }));
      const wrongHostSeat = audit();
      assert.equal(wrongHostSeat.status, 7, wrongHostSeat.stdout + wrongHostSeat.stderr);
      assert.equal(JSON.parse(wrongHostSeat.stdout).code, "PLUGIN_HOST_BINDING_MISMATCH");
      fs.writeFileSync(recordFile, JSON.stringify(record));
      fs.writeFileSync(initialFile, originalInitial);
      fs.writeFileSync(initialFile, "{broken");
      const invalid = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "recovery-check"], { env, encoding: "utf8" });
      assert.equal(invalid.status, 7);
      assert.equal(JSON.parse(invalid.stdout).code, "PLUGIN_DELIVERY_INVALID");
      const duplicate = spawnSync(process.execPath, [coordinator, "start"],
        { env, encoding: "utf8" });
      assert.equal(duplicate.status, 3);
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      return;
    }
    assert.equal(started.status, "started");
    if (failure.startsWith("server-restart")) {
      const failed = waitForLine(child, (value) => value.status === "needs_reconcile");
      fs.writeFileSync(restartedFile, "restarted");
      const fenced = await failed;
      assert.equal(fenced.code, "HERDR_TERMINAL_CHANGED");
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      const snapshot = JSON.parse(spawnSync(process.execPath,
        [cli, "host", "snapshot", "--project", project, "--json"], {
          env, encoding: "utf8",
        }).stdout);
      assert.equal(snapshot.host_state, "claimed");
      const sessionDir = path.join(stateDir, "sessions",
        fs.readdirSync(path.join(stateDir, "sessions"))[0]);
      const record = JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"), "utf8"));
      assert.equal(record.phase, "needs_reconcile");
      const audit = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "recovery-check"], { env, encoding: "utf8" });
      assert.equal(audit.status, 0, audit.stdout + audit.stderr);
      assert.equal(JSON.parse(audit.stdout).seats.ralph.observation, "terminal_changed");
      const tooEarly = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "rebind-check"], { env, encoding: "utf8" });
      assert.equal(tooEarly.status, 7, tooEarly.stdout + tooEarly.stderr);
      assert.equal(JSON.parse(tooEarly.stdout).code, "RECOVERED_LEASE_REQUIRED");
      const reviewed = spawnSync(process.execPath, [cli, "host", "recovery-check",
        "--project", project, "--json"], { env, encoding: "utf8" });
      assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
      const evidence = JSON.parse(reviewed.stdout);
      const recovered = spawnSync(process.execPath, [cli, "host", "recover-lease",
        "--project", project, "--lease-id", evidence.lease_id,
        "--expected-evidence", evidence.evidence_sha256,
        "--decision", "verified-stopped-no-replay", "--json"],
      { env, encoding: "utf8" });
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
      const pluginRecordFile = path.join(sessionDir, "record.json");
      const pluginRecordBefore = fs.readFileSync(pluginRecordFile, "utf8");
      const rebind = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "rebind-check"], { env, encoding: "utf8" });
      assert.equal(rebind.status, 0, rebind.stdout + rebind.stderr);
      const checked = JSON.parse(rebind.stdout);
      assert.equal(checked.status, "review_required");
      assert.deepEqual(checked.continuation_blockers, []);
      assert.equal(checked.old_lease_id, evidence.lease_id);
      assert.equal(checked.binding_plan.seats.ralph.terminal_id, "new-ralph");
      const recoveries = path.join(project, ".dual-agent", "host", "recoveries");
      const recoveryFile = path.join(recoveries, `${checked.recovery_id}.json`);
      const originalRecovery = fs.readFileSync(recoveryFile, "utf8");
      fs.writeFileSync(recoveryFile, JSON.stringify({ ...JSON.parse(originalRecovery),
        decision: "unreviewed" }));
      const invalidProof = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "rebind-check"], { env, encoding: "utf8" });
      assert.equal(invalidProof.status, 7, invalidProof.stdout + invalidProof.stderr);
      assert.equal(JSON.parse(invalidProof.stdout).code, "RECOVERY_PROOF_INVALID");
      fs.writeFileSync(recoveryFile, originalRecovery);
      const wrongSession = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "rebind-check"], {
          env: { ...env, FAKE_RALPH_SESSION: "replacement-session" }, encoding: "utf8",
        });
      assert.equal(wrongSession.status, 4, wrongSession.stdout + wrongSession.stderr);
      assert.ok(JSON.parse(wrongSession.stdout).continuation_blockers.includes(
        "AGENT_SESSION_UNVERIFIED_RALPH"));
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      assert.equal(fs.readFileSync(pluginRecordFile, "utf8"), pluginRecordBefore);
      assert.equal(JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot",
        "--project", project, "--json"], { env, encoding: "utf8" }).stdout).host_state,
      "unclaimed");
      const stale = spawnSync(process.execPath, [coordinator, "rebind",
        "0".repeat(64), "verified-seats-no-replay"], { env, encoding: "utf8" });
      assert.equal(stale.status, 4, stale.stdout + stale.stderr);
      assert.equal(JSON.parse(stale.stdout).code, "REBIND_EVIDENCE_CHANGED");
      if (failure === "server-restart-bind-failure") {
        const marker = path.join(sessionDir, "rebind.pending.json");
        const uncertain = spawnSync(process.execPath, [coordinator, "rebind",
          checked.evidence_sha256, "verified-seats-no-replay"], {
            env: { ...env, FAKE_REBIND_MARKER: marker }, encoding: "utf8",
          });
        assert.equal(uncertain.status, 7, uncertain.stdout + uncertain.stderr);
        assert.equal(JSON.parse(uncertain.stdout).code, "HERDR_TERMINAL_CHANGED");
        assert.equal(fs.existsSync(marker), true);
        assert.equal(JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot",
          "--project", project, "--json"], { env, encoding: "utf8" }).stdout).host_state,
        "claimed");
        const frozen = spawnSync(process.execPath,
          [path.join(root, "actions.mjs"), "recovery-check"], { env, encoding: "utf8" });
        assert.equal(frozen.status, 7);
        assert.equal(JSON.parse(frozen.stdout).code, "REBIND_PENDING_REVIEW");
        assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
        return;
      }
      const rebound = spawnSync(process.execPath, [coordinator, "rebind",
        checked.evidence_sha256, "verified-seats-no-replay"], { env, encoding: "utf8" });
      assert.equal(rebound.status, 0, rebound.stdout + rebound.stderr);
      const reboundValue = JSON.parse(rebound.stdout);
      assert.equal(reboundValue.status, "rebound_paused");
      assert.equal(reboundValue.replay, "not_replayed");
      const reboundSnapshot = JSON.parse(spawnSync(process.execPath,
        [cli, "host", "snapshot", "--project", project, "--json"], {
          env, encoding: "utf8",
        }).stdout);
      assert.equal(reboundSnapshot.host_state, "claimed");
      assert.equal(reboundSnapshot.binding_state, "bound");
      assert.equal(reboundSnapshot.generation, 0);
      assert.equal(reboundSnapshot.owner_id, reboundValue.owner_id);
      const reboundRecord = JSON.parse(fs.readFileSync(pluginRecordFile, "utf8"));
      assert.equal(reboundRecord.phase, "rebound_paused");
      assert.equal(reboundRecord.prior_lease_id, evidence.lease_id);
      assert.equal(fs.existsSync(path.join(sessionDir, `prior-${evidence.lease_id}`,
        `initial-${reboundRecord.session_id}.json`)), true);
      assert.equal(fs.existsSync(path.join(sessionDir, "rebind.pending.json")), false);
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      const reboundAudit = spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "recovery-check"], { env, encoding: "utf8" });
      assert.equal(reboundAudit.status, 0, reboundAudit.stdout + reboundAudit.stderr);
      const reboundReview = JSON.parse(reboundAudit.stdout);
      assert.equal(reboundReview.plugin.initial_status, "inherited_accepted");
      assert.equal(reboundReview.plugin.prior_lease_id, evidence.lease_id);
      assert.deepEqual(reboundReview.deliveries.map((item) => [item.kind, item.status]),
        [["initial", "accepted"]]);
      assert.equal(reboundReview.continuation_blockers.includes("DELIVERY_RECORD_MISSING"), false);
      assert.equal(reboundReview.continuation_blockers.includes("DELIVERY_OUTCOME_UNCERTAIN"), false);
      const continueCheck = (overrides = {}) => spawnSync(process.execPath,
        [path.join(root, "actions.mjs"), "continuation-check"], {
          env: { ...env, ...overrides }, encoding: "utf8",
        });
      const continuation = continueCheck();
      assert.equal(continuation.status, 0, continuation.stdout + continuation.stderr);
      const continuationPlan = JSON.parse(continuation.stdout);
      assert.equal(continuationPlan.status, "review_required");
      assert.deepEqual(continuationPlan.continuation_blockers, []);
      assert.equal(continuationPlan.lease_id, reboundValue.lease_id);
      assert.equal(continuationPlan.generation, 0);
      assert.match(continuationPlan.evidence_sha256, /^[0-9a-f]{64}$/);
      const changedAgent = continueCheck({ FAKE_RALPH_SESSION: "replacement-session" });
      assert.equal(changedAgent.status, 4, changedAgent.stdout + changedAgent.stderr);
      assert.ok(JSON.parse(changedAgent.stdout).continuation_blockers.includes(
        "SEAT_NOT_READY_RALPH"));
      fs.unlinkSync(restartedFile);
      const changedTerminal = continueCheck();
      fs.writeFileSync(restartedFile, "restarted");
      assert.equal(changedTerminal.status, 4, changedTerminal.stdout + changedTerminal.stderr);
      assert.ok(JSON.parse(changedTerminal.stdout).continuation_blockers.includes(
        "SEAT_NOT_READY_RALPH"));
      fs.writeFileSync(path.join(sessionDir, "stop.json"), "{}");
      const pendingControl = continueCheck();
      assert.equal(pendingControl.status, 7, pendingControl.stdout + pendingControl.stderr);
      assert.equal(JSON.parse(pendingControl.stdout).code, "CONTROL_PENDING");
      fs.unlinkSync(path.join(sessionDir, "stop.json"));
      fs.writeFileSync(pluginRecordFile, JSON.stringify({ ...reboundRecord,
        cursor_generation: 1 }));
      const changedCursor = continueCheck();
      assert.equal(changedCursor.status, 7, changedCursor.stdout + changedCursor.stderr);
      assert.ok(["CONTINUATION_CURSOR_MISMATCH", "PLUGIN_LINEAGE_RECORD_INVALID"].includes(
        JSON.parse(changedCursor.stdout).code));
      fs.writeFileSync(pluginRecordFile, JSON.stringify(reboundRecord));
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      const staleContinuation = spawnSync(process.execPath, [coordinator, "continue",
        "0".repeat(64), "reviewed-cursor-no-replay"], { env, encoding: "utf8" });
      assert.equal(staleContinuation.status, 4, staleContinuation.stdout + staleContinuation.stderr);
      assert.equal(JSON.parse(staleContinuation.stdout).code, "CONTINUATION_EVIDENCE_CHANGED");
      if (failure === "server-restart-continue-failure") {
        const marker = path.join(sessionDir, "continuation.pending.json");
        const uncertain = spawnSync(process.execPath, [coordinator, "continue",
          continuationPlan.evidence_sha256, "reviewed-cursor-no-replay"], {
            env: { ...env, FAKE_CONTINUATION_MARKER: marker }, encoding: "utf8",
          });
        assert.equal(uncertain.status, 7, uncertain.stdout + uncertain.stderr);
        assert.equal(JSON.parse(uncertain.stdout).code, "HERDR_TERMINAL_CHANGED");
        assert.equal(fs.existsSync(marker), true);
        const frozen = continueCheck();
        assert.equal(frozen.status, 7, frozen.stdout + frozen.stderr);
        assert.equal(JSON.parse(frozen.stdout).code, "CONTINUATION_PENDING_REVIEW");
        const frozenAudit = spawnSync(process.execPath,
          [path.join(root, "actions.mjs"), "recovery-check"],
        { env, encoding: "utf8" });
        assert.equal(frozenAudit.status, 7, frozenAudit.stdout + frozenAudit.stderr);
        assert.equal(JSON.parse(frozenAudit.stdout).code, "CONTINUATION_PENDING_REVIEW");
        const frozenStop = spawnSync(process.execPath, [coordinator, "stop"],
          { env, encoding: "utf8" });
        assert.equal(frozenStop.status, 7, frozenStop.stdout + frozenStop.stderr);
        assert.equal(JSON.parse(frozenStop.stdout).code, "CONTINUATION_PENDING_REVIEW");
        assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
        return;
      }
      if (["server-restart-continue", "server-restart-continue-uncertain"].includes(failure)) {
        const active = spawn(process.execPath, [coordinator, "continue",
          continuationPlan.evidence_sha256, "reviewed-cursor-no-replay"], {
            env: { ...env, FAKE_PROMPT_FAILURE:
              failure === "server-restart-continue-uncertain" ? "timeout" : failure },
            stdio: ["ignore", "pipe", "pipe"],
          });
        try {
          const continued = await waitForLine(active, (value) =>
            value.status === "continued" || value.status === "needs_reconcile");
          assert.equal(continued.status, "continued", JSON.stringify(continued));
          assert.equal(continued.lease_id, reboundValue.lease_id);
          assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
          const duplicateContinue = spawnSync(process.execPath, [coordinator, "continue",
            continuationPlan.evidence_sha256, "reviewed-cursor-no-replay"],
          { env, encoding: "utf8" });
          assert.notEqual(duplicateContinue.status, 0);
          const host = (action, args = []) => {
            const result = spawnSync(process.execPath, [cli, "host", action,
              "--project", project, ...args, "--json"], { env, encoding: "utf8" });
            assert.equal(result.status, 0, result.stdout + result.stderr);
            return JSON.parse(result.stdout);
          };
          const candidateId = randomUUID();
          const requestId = randomUUID();
          fs.writeFileSync(path.join(project, "candidate.md"),
            "[PLAN] Continue after restart.\n\nTest Plan: npm test\n");
          host("propose", ["--role", "ralph", "--file", "candidate.md",
            "--candidate-id", candidateId]);
          const args = ["--lease-id", reboundValue.lease_id,
            "--request-id", requestId, "--candidate-id", candidateId,
            "--expected-generation", "0", "--expected-binding-generation",
            String(reboundValue.binding_generation)];
          const checkedCommit = host("commit-check", args);
          assert.equal(checkedCommit.status, "awaiting_source_confirmation");
          host("confirm-candidate", [...args, "--expected-content-sha256",
            checkedCommit.content_sha256, "--decision", "reviewed_candidate_source"]);
          const handedOff = waitForLine(active, (value) =>
            value.status === "handed_off" || value.status === "needs_reconcile");
          const receipt = host("commit", args);
          assert.equal(receipt.status, "committed");
          assert.equal(receipt.lease_id, reboundValue.lease_id);
          const delivery = await handedOff;
          if (failure === "server-restart-continue-uncertain") {
            assert.equal(delivery.status, "needs_reconcile", JSON.stringify(delivery));
            assert.equal(delivery.code, "timeout");
            assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\nlisa\n");
            const uncertainAudit = spawnSync(process.execPath,
              [path.join(root, "actions.mjs"), "recovery-check"],
            { env, encoding: "utf8" });
            assert.equal(uncertainAudit.status, 0,
              uncertainAudit.stdout + uncertainAudit.stderr);
            const audit = JSON.parse(uncertainAudit.stdout);
            assert.ok(audit.continuation_blockers.includes("DELIVERY_OUTCOME_UNCERTAIN"));
            assert.deepEqual(audit.deliveries.map((item) => [item.kind, item.status]),
              [["initial", "accepted"], ["handoff", "intent"]]);
            return;
          }
          assert.equal(delivery.status, "handed_off", JSON.stringify(delivery));
          assert.equal(delivery.request_id, requestId);
          assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\nlisa\n");
          const after = spawnSync(process.execPath,
            [path.join(root, "actions.mjs"), "recovery-check"],
          { env, encoding: "utf8" });
          assert.equal(after.status, 0, after.stdout + after.stderr);
          const audit = JSON.parse(after.stdout);
          assert.deepEqual(audit.deliveries.map((item) =>
            [item.kind, item.status, item.generation]),
          [["initial", "accepted", 0], ["handoff", "accepted", 1]]);
          assert.equal(audit.continuation_blockers.includes("DELIVERY_RECORD_MISSING"), false);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\nlisa\n");
          const stoppedContinue = spawnSync(process.execPath, [coordinator, "stop"],
            { env, encoding: "utf8", timeout: 25000 });
          assert.equal(stoppedContinue.status, 0,
            stoppedContinue.stdout + stoppedContinue.stderr);
          if (active.exitCode === null)
            await new Promise((resolve) => active.once("exit", resolve));
        } finally {
          if (active.exitCode === null) active.kill();
        }
        return;
      }
      const duplicateRebind = spawnSync(process.execPath, [coordinator, "rebind",
        checked.evidence_sha256, "verified-seats-no-replay"], { env, encoding: "utf8" });
      assert.notEqual(duplicateRebind.status, 0);
      const prematureResume = spawnSync(process.execPath, [coordinator, "resume"],
        { env, encoding: "utf8" });
      assert.equal(prematureResume.status, 7);
      assert.equal(JSON.parse(prematureResume.stdout).code, "COORDINATOR_NOT_ACTIVE");
      const stopped = spawnSync(process.execPath, [coordinator, "stop"],
        { env, encoding: "utf8" });
      assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
      assert.equal(JSON.parse(stopped.stdout).status, "stopped");
      assert.equal(JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot",
        "--project", project, "--json"], { env, encoding: "utf8" }).stdout).host_state,
      "unclaimed");
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      const restarted = spawnSync(process.execPath, [coordinator, "start"],
        { env, encoding: "utf8" });
      assert.equal(restarted.status, 3, restarted.stdout + restarted.stderr);
      assert.equal(JSON.parse(restarted.stdout).code, "INITIAL_PROMPT_REQUIRES_RECOVERY");
      assert.equal(fs.readFileSync(prompts, "utf8"), "ralph\n");
      return;
    }
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
