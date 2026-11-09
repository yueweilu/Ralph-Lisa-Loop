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

function proposeWhenUnlocked(project, role, file) {
  const candidateId = crypto.randomUUID();
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = spawnSync(process.execPath, [cli, "host", "propose",
      "--project", project, "--role", role, "--file", file,
      "--candidate-id", candidateId, "--json"], { encoding: "utf8" });
    let response;
    try { response = JSON.parse(result.stdout); } catch { /* Assertion below includes output. */ }
    if (result.status !== 4 || response?.code !== "HOST_BUSY") {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return candidateId;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.fail("host propose stayed busy after bounded retries");
}

function waitForStatus(child, expected, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${expected}`)), timeoutMs);
    // 'exit' may precede the final stdout chunk on slower CI runners.
    const onClose = (code) => finish(new Error(`coordinator closed ${code} before ${expected}`));
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
      child.off("close", onClose);
      if (error) reject(error); else resolve(value);
    };
    child.stdout.on("data", onData);
    child.on("close", onClose);
  });
}

for (const scenario of ["normal", "hangup", "changed", "before_prompt", "authorized", "task_update", "completed"]) test(
  scenario === "changed" ? "managed close retains the lease when business state changed" :
    scenario === "before_prompt" ? "managed close before initial prompt retains the lease without delivery" :
    scenario === "authorized" ? "managed launch records a scoped auto grant before the first prompt" :
    scenario === "task_update" ? "Ralph task update commits once, delivers once, and ends the old auto grant" :
    scenario === "completed" ? "managed auto loop stops after formal Lisa consensus" :
    scenario === "hangup" ? "managed pane hangup releases a matching lease" :
    "closing a managed coordinator releases only a matching cursor", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-managed-stop-"));
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  const pluginState = path.join(temp, "plugin-state");
  for (const dir of [project, config, pluginState]) fs.mkdirSync(dir);
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  const fakeCli = path.join(temp, "rll-cli");
  const prompts = path.join(temp, "prompts");
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const a=process.argv.slice(2);const role=a[2];const project=process.env.FAKE_PROJECT;` +
    `const agent=(r)=>({name:r,agent:r==='ralph'?'claude':'codex',workspace_id:'w1',` +
    `pane_id:r==='ralph'?'w1:p1':'w1:p2',terminal_id:r==='ralph'?'term-r':'term-l',` +
    `cwd:project,interactive_ready:true,agent_status:'idle'});` +
    `if(a[0]==='--version')console.log('herdr 0.9.4');` +
    `else if(a[0]==='integration')console.log('claude: installed\\ncodex: installed');` +
    `else if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:agent(role)}}));` +
    `else if(a[0]==='agent'&&a[1]==='prompt'){require('node:fs').appendFileSync(process.env.FAKE_PROMPTS,'1');console.log(JSON.stringify({result:{type:'agent_prompted',agent:agent(role)}}));}` +
    `else process.exitCode=2;\n`);
  fs.writeFileSync(fakeCli, `#!${process.execPath}\n` +
    `const {spawnSync}=require('node:child_process');const a=process.argv.slice(2);` +
    `const r=spawnSync(process.execPath,[process.env.REAL_RLL_CLI,...a],{encoding:'utf8',env:process.env});` +
    `process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');` +
    `if(a[0]==='host'&&a[1]==='prepare-generation'&&r.status===0)` +
    `process.kill(process.ppid,'SIGTERM');process.exitCode=r.status??1;\n`);
  fs.writeFileSync(fakeClaude, `#!${process.execPath}\nconsole.log('{"loggedIn":true}');\n`);
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');\n`);
  for (const file of [fakeHerdr, fakeClaude, fakeCodex, fakeCli]) fs.chmodSync(file, 0o700);
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ project,
    rll_cli_argv: [process.execPath, scenario === "before_prompt" ? fakeCli : cli] }));
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
    permission_profile: "interactive", auto_commit: ["authorized", "task_update", "completed"].includes(scenario),
    ...(["authorized", "task_update", "completed"].includes(scenario)
      ? { auto_commit_granted_via: "cli_auto_host_herdr" } : {}) }));
  fs.writeFileSync(path.join(state, "herdr-launch-workspace.json"), JSON.stringify({ schema: 1,
    request_id: requestId, workspace_id: "w1", root_pane_id: "w1:p1", root_terminal_id: "term-r" }));
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
    CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
    HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: pluginState,
    HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1", workspace_cwd: project }),
    RLL_LAUNCH_REQUEST_ID: requestId, FAKE_PROJECT: project,
    FAKE_PROMPTS: prompts, REAL_RLL_CLI: cli };
  const child = spawn(process.execPath, [coordinator, "start"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await waitForStatus(child, scenario === "before_prompt" ? "needs_reconcile" : "started");
    if (scenario === "before_prompt") {
      assert.equal(started.code, "MANAGED_PANE_CLOSED_DURING_START", JSON.stringify(started));
      assert.equal(JSON.parse(fs.readFileSync(path.join(state, "herdr-launch-result.json"))).status,
        "needs_reconcile");
      assert.equal(fs.existsSync(prompts), false);
    } else {
      assert.equal(started.status, "started", JSON.stringify(started));
      assert.equal(JSON.parse(fs.readFileSync(path.join(state, "herdr-launch-result.json"))).status, "started");
      if (scenario === "completed") {
        const toLisa = waitForStatus(child, "handed_off", 15000);
        fs.writeFileSync(path.join(project, "ralph-consensus.md"),
          "[CONSENSUS] The disposable task is complete.\n");
        proposeWhenUnlocked(project, "ralph", "ralph-consensus.md");
        assert.equal((await toLisa).role, "lisa");
        const completed = waitForStatus(child, "completed", 15000);
        fs.writeFileSync(path.join(project, "lisa-consensus.md"),
          "[CONSENSUS] I independently agree the disposable task is complete.\n");
        proposeWhenUnlocked(project, "lisa", "lisa-consensus.md");
        const completion = await completed;
        assert.equal(completion.status, "completed", JSON.stringify(completion));
        assert.equal(completion.generation, 2);
        const snapshot = spawnSync(process.execPath, [cli, "host", "snapshot",
          "--project", project, "--json"], { encoding: "utf8" });
        assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
        assert.equal(JSON.parse(snapshot.stdout).host_state, "unclaimed");
        assert.equal(JSON.parse(snapshot.stdout).generation, 2);
        const sessionDir = path.join(pluginState, "sessions",
          fs.readdirSync(path.join(pluginState, "sessions"))[0]);
        assert.equal(fs.readdirSync(sessionDir).filter((name) => name.startsWith("delivery-")).length, 1);
        const finished = fs.readdirSync(sessionDir).find((name) => name.startsWith("finished-"));
        assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, finished))).phase, "completed");
        return;
      }
      if (scenario === "authorized") {
        const active = JSON.parse(fs.readFileSync(path.join(pluginState, "sessions",
          fs.readdirSync(path.join(pluginState, "sessions"))[0], "record.json")));
        const authorization = JSON.parse(fs.readFileSync(path.join(state, "host",
          "auto-authorizations", `${active.lease_id}.json`)));
        assert.equal(authorization.status, "active");
        assert.equal(authorization.source_verification, "unverified");
        assert.equal(fs.existsSync(path.join(state, "host", "confirmations")), false);
        const handedOff = waitForStatus(child, "handed_off", 15000);
        const proposal = path.join(project, "candidate.md");
        fs.writeFileSync(proposal,
          "[PLAN] Create README.md with the requested sentence.\n\n" +
          "Test Plan: run cat README.md to verify the exact sentence and single-line scope.\n");
        proposeWhenUnlocked(project, "ralph", "candidate.md");
        const handed = await handedOff;
        assert.equal(handed.status, "handed_off", JSON.stringify(handed));
        assert.equal(handed.role, "lisa");
        const returned = waitForStatus(child, "handed_off", 15000);
        fs.writeFileSync(path.join(project, "lisa-candidate.md"),
          "[NEEDS_WORK] The plan does not specify the exact README sentence.\n\n" +
          "Reason: candidate.md:1 leaves the sentence unspecified, so implementation cannot be checked.\n");
        proposeWhenUnlocked(project, "lisa", "lisa-candidate.md");
        const back = await returned;
        assert.equal(back.status, "handed_off", JSON.stringify(back));
        assert.equal(back.role, "ralph");
        assert.equal(back.generation, 2);
        assert.equal(fs.existsSync(path.join(state, "host", "confirmations")), false);
      }
      if (scenario === "task_update") {
        const toLisa = waitForStatus(child, "handed_off", 15000);
        fs.writeFileSync(path.join(project, "initial-plan.md"),
          "[PLAN] Complete the initial disposable task.\n\nTest Plan: inspect the result.\n");
        proposeWhenUnlocked(project, "ralph", "initial-plan.md");
        assert.equal((await toLisa).role, "lisa");
        const sessionDir = path.join(pluginState, "sessions",
          fs.readdirSync(path.join(pluginState, "sessions"))[0]);
        const active = JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json")));
        let before;
        for (let attempt = 0; attempt < 20 && !before; attempt++) {
          const read = spawnSync(process.execPath, [cli, "host", "snapshot",
            "--project", project, "--json"], { encoding: "utf8" });
          if (read.status === 0) before = JSON.parse(read.stdout);
          else {
            assert.equal(JSON.parse(read.stdout).code, "HOST_BUSY", read.stdout + read.stderr);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          }
        }
        assert.ok(before);
        assert.equal(active.plan.seats.ralph.pane_id, "w1:p1");
        assert.equal(active.plan.seats.ralph.terminal_id, "term-r");
        assert.equal(active.session_id, before.session_id);
        assert.equal(active.cursor_generation, before.generation);
        const body = "Build a homepage instead.\n";
        const taskFile = path.join(project, "task-update.txt");
        fs.writeFileSync(taskFile, body);
        const changeId = crypto.randomUUID();
        const queue = path.join(state, "host", "task-update-requests");
        fs.mkdirSync(queue);
        const committed = waitForStatus(child, "task_update_committed", 15000);
        const delivered = waitForStatus(child, "task_updated_delivered", 15000);
        fs.writeFileSync(path.join(queue, `${changeId}.json`), JSON.stringify({
          schema: 1, status: "requested", request_id: changeId,
          project_realpath: before.project_realpath, session_id: before.session_id,
          workspace_id: "w1", pane_id: "w1:p1", terminal_id: "term-r",
          agent_target: "ralph", generation: before.generation,
          binding_generation: before.binding_generation, state_digest: before.state_digest,
          last_receipt_id: before.last_receipt_id, mode: "switch", file: fs.realpathSync.native(taskFile),
          content_sha256: crypto.createHash("sha256").update(body).digest("hex"),
          source_verification: "unverified", requested_at: new Date().toISOString(),
        }));
        const committedEvent = await committed;
        assert.equal(committedEvent.status, "task_update_committed", JSON.stringify(committedEvent));
        assert.equal(committedEvent.request_id, changeId);
        const delivery = await delivered;
        assert.equal(delivery.request_id, changeId);
        assert.equal(delivery.generation, 2);
        const after = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot",
          "--project", project, "--json"], { encoding: "utf8" }).stdout);
        assert.equal(after.generation, 2);
        assert.equal(after.turn, "ralph");
        assert.equal(fs.readFileSync(prompts, "utf8"), "111");
        assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"))).auto_commit, false);
        assert.equal(fs.readFileSync(path.join(state, "task.md"), "utf8").includes(body.trim()), true);
        const archived = path.join(state, "host", "task-update-requests-archived", `${changeId}.json`);
        for (let i = 0; i < 30 && !fs.existsSync(archived); i++)
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(fs.existsSync(archived), true);
        fs.writeFileSync(path.join(project, "after-change.md"),
          "[PLAN] Work on the new homepage task.\n\nTest Plan: inspect the page.\n");
        const candidateId = proposeWhenUnlocked(project, "ralph", "after-change.md");
        let gate;
        for (let i = 0; i < 20 && !gate; i++) {
          const result = spawnSync(process.execPath, [cli, "host", "commit-check",
            "--project", project, "--lease-id", active.lease_id,
            "--request-id", crypto.randomUUID(), "--candidate-id", candidateId,
            "--expected-generation", "2", "--expected-binding-generation",
            String(before.binding_generation), "--json"], { encoding: "utf8" });
          const value = JSON.parse(result.stdout);
          if (value.code === "HOST_BUSY") {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            continue;
          }
          assert.equal(result.status, 0, result.stdout + result.stderr);
          gate = value;
        }
        assert.equal(gate?.status, "awaiting_source_confirmation");
      }
      if (scenario === "changed") fs.writeFileSync(path.join(state, "work.md"), "Changed after baseline");
      child.kill(scenario === "hangup" ? "SIGHUP" : "SIGTERM");
    }
    const stopped = scenario === "before_prompt" ? started :
      await waitForStatus(child, scenario === "changed" ? "needs_reconcile" : "stopped");
    assert.equal(stopped.status, ["normal", "hangup", "authorized", "task_update"].includes(scenario) ? "stopped" : "needs_reconcile", JSON.stringify(stopped));
    const sessionDir = path.join(pluginState, "sessions",
      fs.readdirSync(path.join(pluginState, "sessions"))[0]);
    if (!["normal", "hangup", "authorized", "task_update"].includes(scenario)) {
      assert.equal(fs.existsSync(path.join(state, "host", "lease")), true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, "record.json"))).phase,
        "needs_reconcile");
      assert.equal(fs.readdirSync(sessionDir).some((name) => name.startsWith("finished-")), false);
      if (scenario === "before_prompt") {
        const snapshot = spawnSync(process.execPath, [cli, "host", "snapshot",
          "--project", project, "--json"], { encoding: "utf8" });
        assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
        assert.equal(JSON.parse(snapshot.stdout).generation, 0);
        assert.equal(fs.readdirSync(sessionDir).some((name) => name.startsWith("initial-")), false);
      }
    } else {
      assert.equal(stopped.reason, "managed_pane_closed");
      const snapshot = spawnSync(process.execPath, [cli, "host", "snapshot",
        "--project", project, "--json"], { encoding: "utf8" });
      assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
      assert.equal(JSON.parse(snapshot.stdout).host_state, "unclaimed");
      assert.equal(JSON.parse(snapshot.stdout).generation, scenario === "authorized" ? 2 :
        scenario === "task_update" ? 2 : 0);
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

test("managed preclaim close retains an auditable result and resumes the same request", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-managed-preclaim-stop-"));
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  const pluginState = path.join(temp, "plugin-state");
  for (const dir of [project, config, pluginState]) fs.mkdirSync(dir);
  const fakeHerdr = path.join(temp, "herdr");
  const fakeClaude = path.join(temp, "claude");
  const fakeCodex = path.join(temp, "codex");
  const startedFlag = path.join(temp, "ralph-started");
  const readyFlag = path.join(temp, "ralph-ready");
  const lisaFlag = path.join(temp, "lisa-started");
  const promptFile = path.join(temp, "prompts");
  const startArgsFile = path.join(temp, "agent-start-args");
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const fs=require('node:fs');const a=process.argv.slice(2);` +
    `const project=process.env.FAKE_PROJECT;const started=process.env.FAKE_STARTED_FLAG;` +
    `const ready=process.env.FAKE_READY_FLAG,lisa=process.env.FAKE_LISA_FLAG;` +
    `const present=(r)=>fs.existsSync(r==='ralph'?started:lisa);` +
    `const agent=(r)=>({name:r,agent:r==='ralph'?'claude':'codex',workspace_id:'w1',` +
    `pane_id:r==='ralph'?'w1:p1':'w1:p2',terminal_id:r==='ralph'?'term-r':'term-l',` +
    `cwd:project,interactive_ready:r==='lisa'||fs.existsSync(ready),` +
    `agent_status:r==='lisa'||fs.existsSync(ready)?'idle':'blocked'});` +
    `const pane=(id)=>({workspace_id:'w1',pane_id:id,terminal_id:id==='w1:p1'?'term-r':'term-l',` +
    `cwd:project,agent:id==='w1:p1'&&present('ralph')?'ralph':id==='w1:p2'&&present('lisa')?'lisa':null});` +
    `const out=(result)=>console.log(JSON.stringify({result}));` +
    `if(a[0]==='--version')console.log('herdr 0.9.4');` +
    `else if(a[0]==='integration')console.log('claude: installed\\ncodex: installed');` +
    `else if(a[0]==='workspace'&&a[1]==='get')out({workspace:{workspace_id:'w1'}});` +
    `else if(a[0]==='pane'&&a[1]==='get')out({pane:pane(a[2])});` +
    `else if(a[0]==='pane'&&a[1]==='split')out({pane:pane('w1:p2')});` +
    `else if(a[0]==='agent'&&a[1]==='start'){fs.appendFileSync(process.env.FAKE_START_ARGS,JSON.stringify(a)+'\\n');fs.writeFileSync(a[2]==='ralph'?started:lisa,'1');out({agent:agent(a[2])});}` +
    `else if(a[0]==='agent'&&a[1]==='get'){if(present(a[2]))out({agent:agent(a[2])});` +
    `else{console.error(JSON.stringify({error:{code:'agent_not_found'}}));process.exitCode=1;}}` +
    `else if(a[0]==='agent'&&a[1]==='prompt'){fs.appendFileSync(process.env.FAKE_PROMPT_FILE,'1');out({type:'agent_prompted',agent:agent(a[2])});}` +
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
    permission_profile: "full_auto", auto_commit: false }));
  fs.writeFileSync(path.join(state, "herdr-launch-workspace.json"), JSON.stringify({ schema: 1,
    request_id: requestId, workspace_id: "w1", root_pane_id: "w1:p1", root_terminal_id: "term-r" }));
  const env = { ...process.env, HERDR_BIN_PATH: fakeHerdr,
    CLAUDE_BIN_PATH: fakeClaude, CODEX_BIN_PATH: fakeCodex,
    HERDR_PLUGIN_CONFIG_DIR: config, HERDR_PLUGIN_STATE_DIR: pluginState,
    HERDR_WORKSPACE_ID: "w1", HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1", workspace_cwd: project }),
    RLL_LAUNCH_REQUEST_ID: requestId, FAKE_PROJECT: project,
    FAKE_STARTED_FLAG: startedFlag, FAKE_READY_FLAG: readyFlag,
    FAKE_LISA_FLAG: lisaFlag, FAKE_PROMPT_FILE: promptFile,
    FAKE_START_ARGS: startArgsFile };
  const child = spawn(process.execPath, [coordinator, "start"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let resumed;
  try {
    const blocked = await waitForStatus(child, "needs_input");
    assert.equal(blocked.role, "ralph");
    child.kill("SIGHUP");
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
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    fs.writeFileSync(readyFlag, "ready");
    resumed = spawn(process.execPath, [coordinator, "start"],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    const started = await waitForStatus(resumed, "started", 30000);
    assert.equal(started.status, "started", JSON.stringify(started));
    const startArgs = fs.readFileSync(startArgsFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(startArgs.find((args) => args[2] === "ralph")?.slice(-2),
      ["--", "--dangerously-skip-permissions"]);
    assert.deepEqual(startArgs.find((args) => args[2] === "lisa")?.slice(-6),
      ["--", "--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "never"]);
    assert.equal(fs.readFileSync(promptFile, "utf8"), "1");
    const currentResult = JSON.parse(fs.readFileSync(path.join(state, "herdr-launch-result.json")));
    assert.equal(currentResult.status, "started");
    assert.equal(currentResult.request_id, requestId);
    const archives = fs.readdirSync(state).filter((name) =>
      /^herdr-launch-result-[0-9a-f-]{36}\.json$/.test(name));
    assert.equal(archives.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, archives[0]))).code,
      "MANAGED_PANE_CLOSED_DURING_START");
    const active = spawnSync(process.execPath, [cli, "host", "snapshot",
      "--project", project, "--json"], { encoding: "utf8" });
    assert.equal(active.status, 0, active.stdout + active.stderr);
    assert.equal(JSON.parse(active.stdout).host_state, "claimed");
    assert.equal(JSON.parse(active.stdout).generation, 0);
    resumed.kill("SIGTERM");
    const released = await waitForStatus(resumed, "stopped", 5000);
    assert.equal(released.status, "stopped", JSON.stringify(released));
  } finally {
    child.kill("SIGKILL");
    resumed?.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
