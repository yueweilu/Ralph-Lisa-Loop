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
    `else if(a[0]==='agent'&&a[1]==='get'){const role=a[2];console.log(JSON.stringify({result:{agent:{name:role,agent:role==='ralph'?'claude':'codex',workspace_id:'w1',pane_id:role==='ralph'?'w1:p1':'w1:p2',cwd:process.env.FAKE_PROJECT,interactive_ready:true,agent_status:'idle'}}}));}\n` +
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
    FAKE_PROJECT: project };
  const child = spawn(process.execPath, [coordinator, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const started = await waitForLine(child, (value) => value.status === "started" || value.status === "needs_reconcile");
    assert.equal(started.status, "started", JSON.stringify(started));
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
    await new Promise((resolve) => setTimeout(resolve, 5500));
    const lease = JSON.parse(fs.readFileSync(path.join(project, ".dual-agent", "host", "lease", "record.json")));
    assert.ok(lease.heartbeat_seq >= 1);
    const stopped = spawnSync(process.execPath, [coordinator, "stop"], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).status, "stopped");
    const released = JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
      encoding: "utf8",
    }).stdout);
    assert.equal(released.host_state, "unclaimed");
    assert.equal(released.binding_state, "stale");
    assert.equal(released.state_digest, before.state_digest);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
