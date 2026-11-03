import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const MIN_HERDR = [0, 9, 4];
const ACTIONS = new Set(["doctor", "status", "seat-preflight", "pause", "resume"]);

function emit(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify({ schema: 1, ...value })}\n`);
  process.exitCode = exitCode;
}

function invoke(argv, args) {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.RL_STATE_DIR;
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 10000,
  });
  return { code: result.status, stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim().slice(0, 500) ?? "",
    error: result.error?.code ?? null };
}

function version(text) {
  const match = text.match(/([0-9]+)\.([0-9]+)\.([0-9]+)/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, minimum) {
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function settings() {
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!configDir) return { value: {}, error: null };
  const file = path.join(configDir, "settings.json");
  if (!fs.existsSync(file)) return { value: {}, error: null };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        (value.project !== undefined && (typeof value.project !== "string" ||
          !path.isAbsolute(value.project))) ||
        (value.rll_cli_argv !== undefined && (!Array.isArray(value.rll_cli_argv) ||
          value.rll_cli_argv.length < 1 || value.rll_cli_argv.length > 4 ||
          !value.rll_cli_argv.every((item) => typeof item === "string" && item.length > 0)))) {
      throw new Error("invalid settings");
    }
    return { value, error: null };
  } catch {
    return { value: {}, error: "INVALID_SETTINGS" };
  }
}

function readJson(result) {
  try { return JSON.parse(result.stdout); }
  catch { return null; }
}

function diagnostics(config) {
  const herdr = [process.env.HERDR_BIN_PATH || "herdr"];
  const cli = config.rll_cli_argv || ["ralph-lisa"];
  const herdrVersion = invoke(herdr, ["--version"]);
  const parsedHerdr = herdrVersion.code === 0 ? version(herdrVersion.stdout) : null;
  const cliVersion = invoke(cli, ["--version"]);
  const parsedCli = cliVersion.code === 0 ? version(cliVersion.stdout) : null;
  const cliProbe = parsedCli ? invoke(cli, ["host", "inspect", "--project", pluginRoot, "--json"]) : null;
  const inspected = cliProbe && readJson(cliProbe);
  const cliContract = cliProbe?.code === 0 && inspected?.status === "ok" &&
    inspected?.schema === 1 && typeof inspected?.project_realpath === "string";
  const integration = parsedHerdr ? invoke(herdr, ["integration", "status"]) : null;
  const claude = integration?.code === 0 && /^claude: installed\b/m.test(integration.stdout);
  const codex = integration?.code === 0 && /^codex: installed\b/m.test(integration.stdout);
  const claudeAuth = invoke([process.env.CLAUDE_BIN_PATH || "claude"], ["auth", "status"]);
  const codexAuth = invoke([process.env.CODEX_BIN_PATH || "codex"], ["login", "status"]);
  const claudeLogin = claudeAuth.code === 0 && readJson(claudeAuth)?.loggedIn === true;
  const codexLogin = codexAuth.code === 0 && /^Logged in\b/im.test(`${codexAuth.stdout}\n${codexAuth.stderr}`);
  const checks = {
    herdr: { ok: !!parsedHerdr && atLeast(parsedHerdr, MIN_HERDR),
      version: parsedHerdr?.join(".") ?? null },
    rll_cli: { ok: !!parsedCli && cliContract, version: parsedCli?.join(".") ?? null,
      host_contract: !!cliContract },
    integrations: { claude: !!claude, codex: !!codex },
    login: { claude: claudeLogin ? "logged_in" : claudeAuth.error ? "unavailable" : "not_logged_in",
      codex: codexLogin ? "logged_in" : codexAuth.error ? "unavailable" : "not_logged_in" },
  };
  return { herdr, cli, checks,
    ready: checks.herdr.ok && checks.rll_cli.ok && claudeLogin && codexLogin };
}

function pluginContext() {
  let context = null;
  try { context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "null"); }
  catch { /* Malformed context cannot select a project. */ }
  return context;
}

function workspaceProject(herdr) {
  const context = pluginContext();
  if (process.env.HERDR_WORKSPACE_ID && context?.workspace_id &&
      process.env.HERDR_WORKSPACE_ID !== context.workspace_id) return null;
  if (typeof context?.workspace_cwd === "string" && path.isAbsolute(context.workspace_cwd))
    return context.workspace_cwd;
  const id = process.env.HERDR_WORKSPACE_ID || context?.workspace_id || context?.workspace?.workspace_id;
  if (!id) return null;
  const result = invoke(herdr, ["workspace", "get", id]);
  const response = readJson(result);
  const workspace = response?.result?.workspace ?? response?.workspace;
  return result.code === 0 && typeof workspace?.cwd === "string" &&
    path.isAbsolute(workspace.cwd) ? workspace.cwd : null;
}

function setupCode(checks) {
  if (!checks.herdr.ok) return "HERDR_VERSION_REQUIRED";
  if (!checks.rll_cli.ok) return "RLL_HOST_CONTRACT_REQUIRED";
  if (checks.login.claude !== "logged_in" || checks.login.codex !== "logged_in")
    return "AGENT_LOGIN_REQUIRED";
  return null;
}

function seatPreflight(diagnosis, snapshot) {
  if (!diagnosis.ready) return { status: "needs_setup", code: setupCode(diagnosis.checks) };
  if (snapshot.host_state !== "unclaimed") return { status: "not_ready", code: "HOST_ALREADY_CLAIMED" };
  const context = pluginContext();
  const workspaceId = process.env.HERDR_WORKSPACE_ID || context?.workspace_id;
  if (!workspaceId || (context?.workspace_id && context.workspace_id !== workspaceId))
    return { status: "not_ready", code: "WORKSPACE_REQUIRED" };
  const seats = {};
  for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]]) {
    const observed = invoke(diagnosis.herdr, ["agent", "get", role]);
    const agent = readJson(observed)?.result?.agent;
    if (observed.code !== 0 || !agent) return { status: "not_ready", code: "AGENT_MISSING", role };
    if (agent.name !== role || agent.agent !== kind || agent.workspace_id !== workspaceId ||
        typeof agent.pane_id !== "string" || !agent.pane_id) {
      return { status: "not_ready", code: "AGENT_IDENTITY_MISMATCH", role };
    }
    let agentCwd = null;
    try { agentCwd = fs.realpathSync.native(agent.cwd); } catch { /* Treat as mismatch. */ }
    if (agentCwd !== snapshot.project_realpath)
      return { status: "not_ready", code: "AGENT_PROJECT_MISMATCH", role };
    if (!agent.interactive_ready || !["idle", "done"].includes(agent.agent_status))
      return { status: "not_ready", code: "AGENT_NOT_READY", role };
    seats[role] = { pane_id: agent.pane_id, agent_target: role, agent_kind: kind };
  }
  if (seats.ralph.pane_id === seats.lisa.pane_id)
    return { status: "not_ready", code: "SEATS_SHARE_PANE" };
  return { status: "ready", code: null, binding_plan: {
    project_realpath: snapshot.project_realpath, session_id: snapshot.session_id,
    expected_digest: snapshot.state_digest, workspace_id: workspaceId, seats,
  } };
}

function main() {
  const action = process.argv[2];
  if (!ACTIONS.has(action)) {
    emit({ status: "error", code: "UNKNOWN_ACTION" }, 2);
    return;
  }
  if (["pause", "resume"].includes(action)) {
    emit({ status: "not_ready", action, code: "S2_COORDINATOR_PENDING",
      message: "Pause and resume await turn handoff coordination" }, 4);
    return;
  }
  const config = settings();
  if (config.error) {
    emit({ status: "needs_setup", code: config.error }, 3);
    return;
  }
  const diagnosis = diagnostics(config.value);
  if (action === "doctor") {
    emit({ status: diagnosis.ready ? "ready" : "needs_setup",
      code: setupCode(diagnosis.checks), checks: diagnosis.checks }, diagnosis.ready ? 0 : 3);
    return;
  }
  const project = config.value.project || workspaceProject(diagnosis.herdr);
  if (!project) {
    emit({ status: "needs_setup", code: "PROJECT_REQUIRED", checks: diagnosis.checks }, 3);
    return;
  }
  if (!diagnosis.checks.rll_cli.ok) {
    emit({ status: "needs_setup", code: "RLL_HOST_CONTRACT_REQUIRED",
      project, checks: diagnosis.checks });
    return;
  }
  const observed = invoke(diagnosis.cli, ["host", "snapshot", "--project", project, "--json"]);
  const snapshot = readJson(observed);
  if (action === "seat-preflight") {
    if (observed.code !== 0 || snapshot?.status !== "ok") {
      emit({ status: "not_ready", code: snapshot?.code || "RLL_SNAPSHOT_FAILED",
        project, checks: diagnosis.checks }, 3);
      return;
    }
    const result = seatPreflight(diagnosis, snapshot);
    emit({ ...result, checks: diagnosis.checks }, result.status === "ready" ? 0 : 3);
    return;
  }
  emit({ status: observed.code === 0 && diagnosis.ready ? "ready" : "needs_setup",
    code: observed.code === 0 ? setupCode(diagnosis.checks)
      : snapshot?.code || "RLL_SNAPSHOT_FAILED",
    project, checks: diagnosis.checks, snapshot }, observed.code === 0 && diagnosis.ready ? 0 : 3);
}

main();
