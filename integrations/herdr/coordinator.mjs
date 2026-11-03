import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emit(value, code = 0) {
  process.stdout.write(`${JSON.stringify({ schema: 1, ...value })}\n`);
  process.exitCode = code;
}

function call(argv, args) {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.RL_STATE_DIR;
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  });
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch { /* Fail closed below. */ }
  return { code: result.status, value, error: result.error?.code ?? null };
}

function config() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  let value = {};
  if (dir) {
    const file = path.join(dir, "settings.json");
    if (fs.existsSync(file)) value = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return { cli: value.rll_cli_argv || ["ralph-lisa"], project: value.project };
}

function projectFromContext() {
  const configured = config().project;
  if (configured) return configured;
  let context = null;
  try { context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "null"); }
  catch { return null; }
  if (process.env.HERDR_WORKSPACE_ID && context?.workspace_id &&
      process.env.HERDR_WORKSPACE_ID !== context.workspace_id) return null;
  return context?.workspace_cwd ?? null;
}

function files(project) {
  if (!stateRoot || !path.isAbsolute(stateRoot)) throw new Error("PLUGIN_STATE_DIR_REQUIRED");
  const real = fs.realpathSync.native(project);
  const key = crypto.createHash("sha256").update(real).digest("hex");
  const dir = path.join(stateRoot, "sessions", key);
  return { real, dir, record: path.join(dir, "record.json"), stop: path.join(dir, "stop.json") };
}

function durableWrite(file, value, exclusive = false) {
  const target = exclusive ? file : `${file}.${crypto.randomUUID()}.pending`;
  const fd = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(target, file);
  const dirFd = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function readRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("STATE_INVALID");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function failRecord(paths, record, code) {
  durableWrite(paths.record, { ...record, phase: "needs_reconcile", error: code });
  emit({ status: "needs_reconcile", code, project: paths.real }, 7);
}

function verifySeat(herdr, plan, role, kind) {
  const result = call(herdr, ["agent", "get", role]);
  const agent = result.value?.result?.agent;
  const expected = plan.seats[role];
  let cwd = null;
  try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Fail closed. */ }
  if (result.code !== 0 || agent?.name !== role || agent?.agent !== kind ||
      agent?.workspace_id !== plan.workspace_id || agent?.pane_id !== expected.pane_id ||
      cwd !== plan.project_realpath || !agent.interactive_ready ||
      !["idle", "done"].includes(agent.agent_status)) throw new Error("AGENT_CHANGED");
}

async function start() {
  const preflight = call([process.execPath, path.join(root, "actions.mjs")], ["seat-preflight"]);
  const plan = preflight.value?.binding_plan;
  if (preflight.code !== 0 || preflight.value?.status !== "ready" || !plan) {
    emit({ status: "not_ready", code: preflight.value?.code || "SEAT_PREFLIGHT_FAILED" }, 3);
    return;
  }
  const paths = files(plan.project_realpath);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const ownerId = crypto.randomUUID();
  let record = { schema: 1, phase: "intent", owner_id: ownerId, pid: process.pid,
    project_realpath: paths.real, session_id: plan.session_id, plan };
  try { durableWrite(paths.record, record, true); }
  catch (error) {
    emit({ status: "not_ready", code: error.code === "EEXIST" ? "COORDINATOR_EXISTS" : "STATE_WRITE_FAILED" }, 4);
    return;
  }
  const cli = config().cli;
  const herdr = [process.env.HERDR_BIN_PATH || "herdr"];
  try {
    const claimed = call(cli, ["host", "claim", "--project", paths.real,
      "--host", "herdr", "--owner-id", ownerId, "--json"]);
    const lease = claimed.value;
    if (claimed.code !== 0 || lease?.status !== "claimed" || !UUID.test(lease.lease_id ?? "") ||
        lease.session_id !== plan.session_id) throw new Error(lease?.code || "CLAIM_UNCERTAIN");
    record = { ...record, phase: "claimed", lease_id: lease.lease_id };
    durableWrite(paths.record, record);
    const snapshot = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
    if (snapshot.code !== 0 || snapshot.value?.session_id !== plan.session_id ||
        snapshot.value?.state_digest !== plan.expected_digest) throw new Error("STATE_CHANGED_AFTER_CLAIM");
    for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]]) {
      verifySeat(herdr, plan, role, kind);
      const seat = plan.seats[role];
      const bound = call(cli, ["host", "bind-seat", "--project", paths.real,
        "--lease-id", lease.lease_id, "--role", role, "--workspace-id", plan.workspace_id,
        "--pane-id", seat.pane_id, "--agent-target", seat.agent_target, "--json"]);
      if (bound.code !== 0 || bound.value?.status !== "bound" ||
          bound.value?.lease_id !== lease.lease_id) throw new Error(bound.value?.code || "BIND_UNCERTAIN");
      record = { ...record, phase: `bound_${role}` };
      durableWrite(paths.record, record);
    }
    const current = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
    if (current.code !== 0 || current.value?.host_state !== "claimed" ||
        current.value?.owner_id !== ownerId || current.value?.binding_state !== "bound" ||
        current.value?.seats?.ralph?.pane_id !== plan.seats.ralph.pane_id ||
        current.value?.seats?.lisa?.pane_id !== plan.seats.lisa.pane_id) {
      throw new Error("BINDING_SNAPSHOT_MISMATCH");
    }
    record = { ...record, phase: "active", binding_generation: current.value.binding_generation };
    durableWrite(paths.record, record);
    emit({ status: "started", project: paths.real, workspace_id: plan.workspace_id,
      binding_generation: record.binding_generation, owner_id: ownerId, lease_id: lease.lease_id });
    let ticks = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (fs.existsSync(paths.stop)) {
        const request = readRecord(paths.stop);
        if (request.owner_id !== ownerId || request.lease_id !== lease.lease_id)
          throw new Error("STOP_REQUEST_MISMATCH");
        const released = call(cli, ["host", "release", "--project", paths.real,
          "--lease-id", lease.lease_id, "--json"]);
        if (released.code !== 0 || released.value?.status !== "released")
          throw new Error(released.value?.code || "RELEASE_UNCERTAIN");
        record = { ...record, phase: "released" };
        durableWrite(paths.record, record);
        fs.renameSync(paths.record, path.join(paths.dir, `finished-${ownerId}.json`));
        fs.unlinkSync(paths.stop);
        emit({ status: "stopped", project: paths.real, owner_id: ownerId });
        return;
      }
      if (++ticks % 5 === 0) {
        const heartbeat = call(cli, ["host", "heartbeat", "--project", paths.real,
          "--lease-id", lease.lease_id, "--owner-id", ownerId, "--json"]);
        if (heartbeat.code !== 0 || heartbeat.value?.lease_id !== lease.lease_id)
          throw new Error(heartbeat.value?.code || "HEARTBEAT_UNCERTAIN");
      }
    }
  } catch (error) { failRecord(paths, record, error.message || "COORDINATOR_ERROR"); }
}

async function stop() {
  const project = projectFromContext();
  if (!project) { emit({ status: "not_ready", code: "PROJECT_REQUIRED" }, 3); return; }
  const paths = files(project);
  let record;
  try { record = readRecord(paths.record); }
  catch { emit({ status: "not_ready", code: "COORDINATOR_NOT_RUNNING" }, 4); return; }
  if (record.phase !== "active" || !UUID.test(record.lease_id ?? "")) {
    emit({ status: "needs_reconcile", code: "COORDINATOR_NOT_ACTIVE" }, 7);
    return;
  }
  try { durableWrite(paths.stop, { owner_id: record.owner_id, lease_id: record.lease_id }, true); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!fs.existsSync(paths.record)) { emit({ status: "stopped", project: paths.real }); return; }
    const current = readRecord(paths.record);
    if (current.phase === "needs_reconcile") break;
  }
  emit({ status: "needs_reconcile", code: "STOP_UNCONFIRMED", project: paths.real }, 7);
}

try {
  if (process.argv[2] === "start") await start();
  else if (process.argv[2] === "stop") await stop();
  else emit({ status: "error", code: "UNKNOWN_ACTION" }, 2);
} catch (error) {
  emit({ status: "error", code: error.message || "COORDINATOR_ERROR" }, 7);
}
