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
    FAKE_HERDR_VERSION: options.version ?? "herdr 0.9.4",
    FAKE_HERDR_INTEGRATIONS: options.integrations ?? "installed",
    FAKE_HERDR_WORKSPACE: project,
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
    `else if (args[0] === 'integration') console.log(process.env.FAKE_HERDR_INTEGRATIONS === 'installed' ? 'claude: installed\\ncodex: installed' : 'claude: not installed\\ncodex: not installed');\n` +
    `else if (args[0] === 'workspace') console.log(JSON.stringify({result:{workspace:{cwd:process.env.FAKE_HERDR_WORKSPACE}}}));\n` +
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
  const absent = run("doctor", { integrations: "absent" });
  assert.equal(absent.code, 3);
  assert.equal(absent.value.status, "needs_setup");
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
});

test("status rejects ambiguous project and malformed settings", () => {
  assert.equal(run("status").value.code, "PROJECT_REQUIRED");
  fs.writeFileSync(path.join(temp, "settings.json"), '{"project":"relative"}');
  const malformed = run("doctor");
  assert.equal(malformed.code, 3);
  assert.equal(malformed.value.code, "INVALID_SETTINGS");
});

test("mutating actions refuse to start agents before coordinator exists", () => {
  for (const action of ["start", "pause", "resume", "stop"]) {
    const result = run(action);
    assert.equal(result.code, 4);
    assert.equal(result.value.code, "S2_COORDINATOR_PENDING");
  }
  assert.equal(fs.existsSync(project), false);
});
