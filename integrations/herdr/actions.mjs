import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const MIN_HERDR = [0, 9, 4];
const ACTIONS = new Set(["doctor", "status", "seat-preflight", "recovery-check"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function coordinatorState(snapshot) {
  const root = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!root || !path.isAbsolute(root) || snapshot?.status !== "ok") return null;
  const key = crypto.createHash("sha256").update(snapshot.project_realpath).digest("hex");
  const file = path.join(root, "sessions", key, "record.json");
  if (!fs.existsSync(file)) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid record");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.project_realpath !== snapshot.project_realpath ||
        record.session_id !== snapshot.session_id) throw new Error("wrong session");
    return { phase: record.phase, cursor_generation: record.cursor_generation ?? null,
      initial_status: record.initial_status ?? null,
      paused_at: record.paused_at ?? null, control_error: record.control_error ?? null };
  } catch { return { phase: "needs_reconcile", code: "PLUGIN_RECORD_INVALID" }; }
}

function regularJson(file, code = "PLUGIN_RECORD_INVALID") {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid file");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid JSON object");
    return value;
  } catch { throw new Error(code); }
}

function recoveryPluginState(projectRealpath, cliEvidence) {
  const root = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error("PLUGIN_STATE_DIR_REQUIRED");
  const key = crypto.createHash("sha256").update(projectRealpath).digest("hex");
  const dir = path.join(root, "sessions", key);
  if (!fs.existsSync(dir)) return { record: null, deliveries: [], warning: "PLUGIN_RECORD_MISSING" };
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("PLUGIN_RECORD_INVALID");
  const recordPath = path.join(dir, "record.json");
  if (!fs.existsSync(recordPath))
    return { record: null, deliveries: [], warning: "PLUGIN_RECORD_MISSING" };
  const record = regularJson(recordPath);
  if (record.project_realpath !== projectRealpath ||
      record.session_id !== cliEvidence.session_id ||
      record.lease_id !== cliEvidence.lease_id ||
      record.owner_id !== cliEvidence.owner_id ||
      !UUID.test(record.owner_id ?? "")) throw new Error("PLUGIN_LEASE_MISMATCH");
  if (!Number.isSafeInteger(record.pid) || record.pid < 1 ||
      typeof record.phase !== "string") throw new Error("PLUGIN_RECORD_INVALID");
  if (record.binding_generation !== undefined &&
      record.binding_generation !== cliEvidence.binding_generation)
    throw new Error("PLUGIN_BINDING_MISMATCH");
  const plan = record.plan;
  if (plan && (plan.project_realpath !== projectRealpath ||
      plan.session_id !== record.session_id ||
      typeof plan.workspace_id !== "string" || !plan.workspace_id ||
      typeof plan.seats?.ralph?.pane_id !== "string" ||
      typeof plan.seats?.lisa?.pane_id !== "string" ||
      plan.seats.ralph.pane_id === plan.seats.lisa.pane_id))
    throw new Error("PLUGIN_BINDING_MISMATCH");
  const names = fs.readdirSync(dir).filter((name) =>
    name.startsWith("initial-") || name.startsWith("delivery-"));
  if (names.length && (!plan || record.binding_generation !== cliEvidence.binding_generation))
    throw new Error("PLUGIN_BINDING_MISMATCH");
  const deliveries = names.map((name) => {
    if (!/^(?:initial|delivery)-[0-9a-f-]{36}\.json$/i.test(name))
      throw new Error("PLUGIN_DELIVERY_INVALID");
    const value = regularJson(path.join(dir, name), "PLUGIN_DELIVERY_INVALID");
    if (!UUID.test(name.slice(name.indexOf("-") + 1, -5)) ||
        !["intent", "accepted"].includes(value.status) ||
        value.owner_id !== record.owner_id || value.lease_id !== record.lease_id ||
        !["ralph", "lisa"].includes(value.role) ||
        value.workspace_id !== plan.workspace_id ||
        value.pane_id !== plan.seats[value.role]?.pane_id ||
        !/^[0-9a-f]{64}$/.test(value.message_sha256 ?? "") ||
        !Number.isSafeInteger(value.generation) || value.generation < 0 ||
        (name.startsWith("initial-") ? value.session_id !== record.session_id ||
          name.slice(8, -5) !== record.session_id || value.generation !== 0 ||
          value.role !== "ralph" :
          value.request_id !== name.slice(9, -5) || value.generation === 0))
      throw new Error("PLUGIN_DELIVERY_INVALID");
    return { kind: name.startsWith("initial-") ? "initial" : "handoff",
      status: value.status, role: value.role, generation: value.generation ?? null,
      id: name.slice(name.indexOf("-") + 1, -5) };
  }).sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
  return { record: { phase: record.phase, pid: record.pid,
    session_id: record.session_id, owner_id: record.owner_id,
    lease_id: record.lease_id, binding_generation: record.binding_generation ?? null,
    cursor_generation: record.cursor_generation ?? null,
    cursor_receipt_id: record.cursor_receipt_id ?? null,
    initial_status: record.initial_status ?? null,
    error: record.error ?? null }, deliveries,
    warning: deliveries.some((item) => item.status === "intent") ?
      "DELIVERY_OUTCOME_UNCERTAIN" : null };
}

function nativeSessionReference(agent, kind) {
  if (!agent) return { status: "unavailable", fingerprint_sha256: null };
  const reference = agent.agent_session;
  if (reference == null) return { status: "missing", fingerprint_sha256: null };
  if (reference.agent !== kind || typeof reference.kind !== "string" || !reference.kind ||
      typeof reference.source !== "string" || !reference.source ||
      typeof reference.value !== "string" || !reference.value)
    return { status: "invalid", fingerprint_sha256: null };
  return { status: "present", fingerprint_sha256: crypto.createHash("sha256")
    .update(JSON.stringify({ agent: reference.agent, kind: reference.kind,
      source: reference.source, value: reference.value })).digest("hex") };
}

function recoverySeats(herdr, projectRealpath, recordPlan) {
  if (!recordPlan?.seats || !recordPlan.workspace_id) return null;
  const seats = {};
  for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]]) {
    const result = invoke(herdr, ["agent", "get", role]);
    const agent = readJson(result)?.result?.agent;
    let cwd = null;
    try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Unavailable is not proof of exit. */ }
    const nativeSession = nativeSessionReference(result.code === 0 ? agent : null, kind);
    seats[role] = { observation: result.code !== 0 || !agent ? "unavailable" :
      agent.name === role && agent.agent === kind &&
      agent.workspace_id === recordPlan.workspace_id &&
      agent.pane_id === recordPlan.seats[role]?.pane_id && cwd === projectRealpath ?
        "matches_binding" : "identity_changed",
      status: agent?.agent_status ?? null,
      pane_id: agent?.pane_id ?? null,
      native_session: nativeSession };
  }
  return seats;
}

function recoveryAudit(diagnosis, project) {
  const checked = invoke(diagnosis.cli, ["host", "recovery-check", "--project", project, "--json"]);
  const evidence = readJson(checked);
  if (checked.code !== 0 || evidence?.status !== "review_required") {
    emit({ status: "not_ready", code: evidence?.code || "RLL_RECOVERY_CHECK_FAILED",
      project }, checked.code === 7 ? 7 : 4);
    return;
  }
  try {
    const plugin = recoveryPluginState(evidence.project_realpath, evidence);
    const key = crypto.createHash("sha256").update(evidence.project_realpath).digest("hex");
    const recordPath = path.join(process.env.HERDR_PLUGIN_STATE_DIR, "sessions", key, "record.json");
    const plan = plugin.record ? regularJson(recordPath).plan : null;
    const observed = invoke(diagnosis.cli, ["host", "snapshot", "--project",
      evidence.project_realpath, "--json"]);
    const snapshot = readJson(observed);
    if (observed.code !== 0 || snapshot?.status !== "ok" ||
        snapshot.project_realpath !== evidence.project_realpath ||
        snapshot.session_id !== evidence.session_id ||
        snapshot.owner_id !== evidence.owner_id ||
        snapshot.binding_generation !== evidence.binding_generation ||
        snapshot.generation !== evidence.generation ||
        snapshot.state_digest !== evidence.state_digest)
      throw new Error("RECOVERY_STATE_CHANGED");
    if (plugin.deliveries.length &&
        (snapshot.binding_state !== "bound" ||
          snapshot.workspace_id !== plan.workspace_id ||
          snapshot.seats?.ralph?.pane_id !== plan.seats.ralph.pane_id ||
          snapshot.seats?.lisa?.pane_id !== plan.seats.lisa.pane_id))
      throw new Error("PLUGIN_HOST_BINDING_MISMATCH");
    const seats = recoverySeats(diagnosis.herdr, evidence.project_realpath, plan);
    emit({ status: "review_required", project: evidence.project_realpath,
      cli: evidence, plugin: plugin.record, deliveries: plugin.deliveries,
      plugin_warning: plugin.warning,
      seats,
      restart_observation: !seats ? "binding_plan_unavailable" :
        Object.values(seats).every((seat) => seat.observation === "matches_binding" &&
          seat.native_session.status === "present") ?
          "native_session_references_present" : "manual_rebind_required",
      note: "Native session reference presence does not prove continuity across restart. Read-only observations do not prove coordinator or Agents stopped; inspect before recover-lease." });
  } catch (error) {
    emit({ status: "needs_reconcile", code: error.message || "PLUGIN_RECOVERY_INVALID",
      project: evidence.project_realpath, cli: evidence }, 7);
  }
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
  const claude = integration?.code === 0 && /^claude: (?:installed|current)\b/m.test(integration.stdout);
  const codex = integration?.code === 0 && /^codex: (?:installed|current)\b/m.test(integration.stdout);
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
  if (action === "recovery-check") {
    recoveryAudit(diagnosis, project);
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
    project, checks: diagnosis.checks, snapshot,
    coordination: coordinatorState(snapshot) }, observed.code === 0 && diagnosis.ready ? 0 : 3);
}

main();
