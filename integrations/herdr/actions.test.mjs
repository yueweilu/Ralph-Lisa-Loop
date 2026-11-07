import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(root, "../../cli/dist/cli.js");
let temp;
let project;
let herdr;
let claude;
let codex;

function run(action, options = {}) {
  const env = {
    ...process.env,
    HERDR_BIN_PATH: herdr,
    CLAUDE_BIN_PATH: claude,
    CODEX_BIN_PATH: codex,
    HERDR_PLUGIN_CONFIG_DIR: temp,
    HERDR_WORKSPACE_ID: options.workspaceId ?? "",
    HERDR_PLUGIN_CONTEXT_JSON: options.context ?? "",
    RLL_LAUNCH_REQUEST_ID: options.launchRequestId ?? "",
    FAKE_HERDR_VERSION: options.version ?? "herdr 0.9.4",
    FAKE_HERDR_INTEGRATIONS: options.integrations ?? "installed",
    FAKE_HERDR_WORKSPACE: project,
    FAKE_HERDR_AGENT_SCENARIO: options.agentScenario ?? "ok",
    FAKE_LOGIN: options.login ?? "logged_in",
  };
  const result = spawnSync(process.execPath, [path.join(root, "actions.mjs"), action], {
    env, cwd: root, encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout);
  return { code: result.status, value: JSON.parse(lines[0]) };
}

function config(value) {
  fs.writeFileSync(path.join(temp, "settings.json"), JSON.stringify({
    rll_cli_argv: [process.execPath, cli], ...value,
  }));
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-plugin-"));
  project = path.join(temp, "project");
  herdr = path.join(temp, "herdr");
  claude = path.join(temp, "claude");
  codex = path.join(temp, "codex");
  fs.writeFileSync(herdr, `#!${process.execPath}\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[0] === '--version') console.log(process.env.FAKE_HERDR_VERSION);\n` +
    `else if (args[0] === 'integration') console.log(process.env.FAKE_HERDR_INTEGRATIONS === 'installed' ? 'claude: installed\\ncodex: installed' : process.env.FAKE_HERDR_INTEGRATIONS === 'current' ? 'claude: current (v10)\\ncodex: current (v9)' : 'claude: not installed\\ncodex: not installed');\n` +
    `else if (args[0] === 'workspace') console.log(JSON.stringify({result:{workspace:{cwd:process.env.FAKE_HERDR_WORKSPACE}}}));\n` +
    `else if (args[0] === 'agent' && args[1] === 'get') {\n` +
    `  const role = args[2], scenario = process.env.FAKE_HERDR_AGENT_SCENARIO;\n` +
    `  const agent = {name:role,agent:role === 'ralph' ? 'claude' : 'codex',workspace_id:'w1',pane_id:role === 'ralph' ? 'w1:p1' : 'w1:p2',terminal_id:role === 'ralph' ? 'term-r' : 'term-l',cwd:process.env.FAKE_HERDR_WORKSPACE,interactive_ready:true,agent_status:'idle'};\n` +
    `  if (scenario === 'wrong-kind' && role === 'lisa') agent.agent = 'claude';\n` +
    `  if (scenario === 'same-pane' && role === 'lisa') agent.pane_id = 'w1:p1';\n` +
    `  if (scenario === 'blocked' && role === 'lisa') agent.agent_status = 'blocked';\n` +
    `  if (scenario === 'missing-terminal' && role === 'lisa') delete agent.terminal_id;\n` +
    `  if (scenario === 'native-session' && role === 'ralph') agent.agent_session = {agent:'claude',kind:'id',source:'herdr:claude',value:'session-123'};\n` +
    `  if (scenario === 'invalid-session' && role === 'lisa') agent.agent_session = {agent:'claude',kind:'id',source:'herdr:codex',value:'session-456'};\n` +
    `  console.log(JSON.stringify({result:{agent}}));\n` +
    `}\n` +
    `else process.exit(2);\n`);
  fs.chmodSync(herdr, 0o700);
  fs.writeFileSync(claude, `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:process.env.FAKE_LOGIN === 'logged_in'}));\n`);
  fs.writeFileSync(codex, `#!${process.execPath}\nconsole.log(process.env.FAKE_LOGIN === 'logged_in' ? 'Logged in using ChatGPT' : 'Not logged in');\n`);
  fs.chmodSync(claude, 0o700);
  fs.chmodSync(codex, 0o700);
  config({});
});

afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

test("doctor probes the real host contract and distinguishes missing integrations", () => {
  const healthy = run("doctor");
  assert.equal(healthy.code, 0);
  assert.equal(healthy.value.status, "ready", JSON.stringify(healthy.value));
  assert.equal(healthy.value.checks.rll_cli.host_contract, true);
  assert.equal(healthy.value.checks.login.claude, "logged_in");
  const current = run("doctor", { integrations: "current" });
  assert.equal(current.value.checks.integrations.claude, true);
  assert.equal(current.value.checks.integrations.codex, true);
  const absent = run("doctor", { integrations: "absent" });
  assert.equal(absent.code, 0);
  assert.equal(absent.value.status, "ready");
  assert.equal(absent.value.checks.integrations.claude, false);
  assert.equal(absent.value.checks.integrations.codex, false);
});

test("doctor reports incompatible Herdr and missing CLI without claiming readiness", () => {
  assert.equal(run("doctor", { version: "herdr 0.9.3" }).value.checks.herdr.ok, false);
  config({ rll_cli_argv: [path.join(temp, "missing-cli")] });
  const absent = run("doctor");
  assert.equal(absent.value.status, "needs_setup");
  assert.equal(absent.value.checks.rll_cli.ok, false);
});

test("doctor distinguishes missing agent login from missing integrations", () => {
  const loggedOut = run("doctor", { login: "logged_out" });
  assert.equal(loggedOut.code, 3);
  assert.equal(loggedOut.value.status, "needs_setup");
  assert.equal(loggedOut.value.code, "AGENT_LOGIN_REQUIRED");
  assert.equal(loggedOut.value.checks.login.claude, "not_logged_in");
  assert.equal(loggedOut.value.checks.login.codex, "not_logged_in");
});

test("launch context rejects a configured project from another Workspace", () => {
  fs.mkdirSync(project);
  const other = path.join(temp, "other");
  fs.mkdirSync(other);
  config({ project });
  const result = run("status", { workspaceId: "w1",
    context: JSON.stringify({ workspace_id: "w1", workspace_cwd: other }),
    launchRequestId: "123e4567-e89b-42d3-a456-426614174000" });
  assert.equal(result.code, 3);
  assert.equal(result.value.code, "LAUNCH_PROJECT_MISMATCH");
  assert.equal(fs.existsSync(path.join(project, ".dual-agent")), false);
  assert.equal(fs.existsSync(path.join(other, ".dual-agent")), false);
});

test("status reads one initialized project without creating host state", () => {
  fs.mkdirSync(project);
  const init = spawnSync(process.execPath, [cli, "init", "--minimal", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const state = path.join(project, ".dual-agent");
  const before = fs.readFileSync(path.join(state, "task.md"));
  config({ project });
  const status = run("status");
  assert.equal(status.code, 0);
  assert.equal(status.value.status, "ready");
  assert.equal(status.value.snapshot.project_realpath, fs.realpathSync.native(project));
  assert.equal(status.value.snapshot.host_state, "unclaimed");
  assert.deepEqual(fs.readFileSync(path.join(state, "task.md")), before);
  assert.equal(fs.existsSync(path.join(project, ".rll-host-command-lock")), false);
  config({});
  const workspaceStatus = run("status", { workspaceId: "workspace-test" });
  assert.equal(workspaceStatus.value.snapshot.state_digest, status.value.snapshot.state_digest);
  const contextStatus = run("status", { context: JSON.stringify({
    workspace_id: "workspace-test", workspace_cwd: project,
  }) });
  assert.equal(contextStatus.value.snapshot.state_digest, status.value.snapshot.state_digest);
  const mismatch = run("status", { workspaceId: "other-workspace", context: JSON.stringify({
    workspace_id: "workspace-test", workspace_cwd: project,
  }) });
  assert.equal(mismatch.value.code, "PROJECT_REQUIRED");
});

test("recovery-check reports an unclaimed session without changing it", () => {
  fs.mkdirSync(project);
  const init = spawnSync(process.execPath, [cli, "init", "--minimal", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  config({ project });
  const result = run("recovery-check");
  assert.equal(result.code, 4);
  assert.equal(result.value.code, "HOST_NOT_CLAIMED");
  assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease")), false);
});

test("status rejects ambiguous project and malformed settings", () => {
  const ambiguous = run("status");
  assert.equal(ambiguous.code, 3);
  assert.equal(ambiguous.value.code, "PROJECT_REQUIRED");
  fs.writeFileSync(path.join(temp, "settings.json"), '{"project":"relative"}');
  const malformed = run("doctor");
  assert.equal(malformed.code, 3);
  assert.equal(malformed.value.code, "INVALID_SETTINGS");
});

test("seat preflight verifies real CLI state and two distinct Herdr agent identities", () => {
  fs.mkdirSync(project);
  const init = spawnSync(process.execPath, [cli, "init", "--minimal", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  config({ project });
  const context = JSON.stringify({ workspace_id: "w1", workspace_cwd: project });
  const ready = run("seat-preflight", { context, integrations: "absent" });
  assert.equal(ready.code, 0);
  assert.equal(ready.value.status, "ready");
  assert.equal(ready.value.binding_plan.workspace_id, "w1");
  assert.equal(ready.value.binding_plan.seats.ralph.pane_id, "w1:p1");
  assert.equal(ready.value.binding_plan.seats.ralph.terminal_id, "term-r");
  assert.equal(ready.value.binding_plan.seats.lisa.agent_kind, "codex");
  assert.equal(ready.value.binding_plan.seats.lisa.native_session_fingerprint_sha256, null);
  const native = run("seat-preflight", { context, agentScenario: "native-session" });
  assert.match(native.value.binding_plan.seats.ralph.native_session_fingerprint_sha256,
    /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(native.value), /session-123/);
  assert.equal(ready.value.checks.integrations.codex, false);
  assert.equal(ready.value.binding_plan.expected_digest,
    JSON.parse(spawnSync(process.execPath, [cli, "host", "snapshot", "--project", project, "--json"], {
      encoding: "utf8",
    }).stdout).state_digest);
  assert.equal(run("seat-preflight", { context, agentScenario: "wrong-kind" }).value.code,
    "AGENT_IDENTITY_MISMATCH");
  assert.equal(run("seat-preflight", { context, agentScenario: "same-pane" }).value.code,
    "SEATS_SHARE_PANE");
  assert.equal(run("seat-preflight", { context, agentScenario: "blocked" }).value.code,
    "AGENT_NOT_READY");
  assert.equal(run("seat-preflight", { context, agentScenario: "missing-terminal" }).value.code,
    "AGENT_IDENTITY_MISMATCH");
  assert.equal(run("seat-preflight", { context, agentScenario: "invalid-session" }).value.code,
    "AGENT_SESSION_INVALID");
  assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "lease")), false);
});

test("control actions are handled by the coordinator entrypoint", () => {
  for (const action of ["pause", "resume"]) {
    const result = run(action);
    assert.equal(result.code, 2);
    assert.equal(result.value.code, "UNKNOWN_ACTION");
  }
  assert.equal(fs.existsSync(project), false);
});
