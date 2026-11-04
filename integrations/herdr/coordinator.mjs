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

function call(argv, args, options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.RL_STATE_DIR;
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 10000,
  });
  let value = null;
  try { value = JSON.parse((result.stdout || result.stderr || "").trim()); }
  catch { /* Fail closed below. */ }
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
  return { real, dir, record: path.join(dir, "record.json"),
    stop: path.join(dir, "stop.json"), control: path.join(dir, "control.json") };
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

function hostBusy(result) {
  return result.value?.code === "HOST_BUSY";
}

function requireActiveSnapshot(result, paths, record, plan) {
  const value = result.value;
  if (result.code !== 0 || value?.status !== "ok" ||
      value.project_realpath !== paths.real || value.session_id !== record.session_id ||
      value.host_state !== "claimed" || value.owner_id !== record.owner_id ||
      value.binding_state !== "bound" || value.binding_generation !== record.binding_generation ||
      value.workspace_id !== plan.workspace_id ||
      value.seats?.ralph?.pane_id !== plan.seats.ralph.pane_id ||
      value.seats?.lisa?.pane_id !== plan.seats.lisa.pane_id ||
      !Number.isSafeInteger(value.generation) || value.generation < 0)
    throw new Error(value?.code || "ACTIVE_SNAPSHOT_MISMATCH");
  return value;
}

function deliveryFile(paths, requestId) {
  if (!UUID.test(requestId)) throw new Error("INVALID_RECEIPT_ID");
  return path.join(paths.dir, `delivery-${requestId.toLowerCase()}.json`);
}

function initialFile(paths, sessionId) {
  if (!UUID.test(sessionId)) throw new Error("INVALID_SESSION_ID");
  return path.join(paths.dir, `initial-${sessionId.toLowerCase()}.json`);
}

function submitPrompt(paths, record, herdr, plan, role, message, file, details) {
  verifySeat(herdr, plan, role, role === "ralph" ? "claude" : "codex");
  const intent = { schema: 1, status: "intent", owner_id: record.owner_id,
    lease_id: record.lease_id, role, workspace_id: plan.workspace_id,
    pane_id: plan.seats[role].pane_id,
    message_sha256: crypto.createHash("sha256").update(message).digest("hex"),
    ...details };
  durableWrite(file, intent, true);
  const submitted = call(herdr, ["agent", "prompt", role, message]);
  if (submitted.code !== 0 || submitted.value?.error)
    throw new Error(submitted.value?.error?.code || submitted.error || "PROMPT_UNCERTAIN");
  const acknowledged = submitted.value?.result;
  let acknowledgedCwd = null;
  try { acknowledgedCwd = fs.realpathSync.native(acknowledged.agent.cwd); }
  catch { /* A missing or changed project is not an acknowledged seat. */ }
  if (acknowledged?.type !== "agent_prompted" ||
      acknowledged.agent?.name !== role ||
      acknowledged.agent?.agent !== (role === "ralph" ? "claude" : "codex") ||
      acknowledged.agent?.workspace_id !== plan.workspace_id ||
      acknowledged.agent?.pane_id !== plan.seats[role].pane_id ||
      acknowledgedCwd !== paths.real)
    throw new Error("PROMPT_ACK_MISMATCH");
  durableWrite(file, { ...intent, status: "accepted" });
}

function requireTaskFile(snapshot) {
  const task = path.join(snapshot.state_realpath, "task.md");
  try {
    const stat = fs.lstatSync(task);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
      throw new Error("invalid task file");
  } catch { throw new Error("TASK_FILE_INVALID"); }
  return task;
}

function deliverInitial(paths, record, cli, herdr, plan, taskFile) {
  const observed = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
  const snapshot = requireActiveSnapshot(observed, paths, record, plan);
  if (snapshot.generation !== 0 || snapshot.last_receipt_id !== null ||
      snapshot.turn !== "ralph" || snapshot.state_digest !== record.expected_digest)
    throw new Error("INITIAL_STATE_CHANGED");
  const message = `Initial Ralph-Lisa task. Project: ${paths.real}. Session: ${record.session_id}. ` +
    `You are Ralph in round ${snapshot.round}. Read ${taskFile} and the current RLL state, ` +
    "then work in the project. Prepare a candidate file and follow the RLL host contract. " +
    "The current source gate requires a human to review and confirm each candidate before commit; do not bypass it.";
  submitPrompt(paths, record, herdr, plan, "ralph", message,
    initialFile(paths, record.session_id), { session_id: record.session_id, generation: 0 });
  record = { ...record, initial_status: "accepted" };
  durableWrite(paths.record, record);
  emit({ status: "initial_prompted", project: paths.real, session_id: record.session_id,
    role: "ralph", pane_id: plan.seats.ralph.pane_id });
  return record;
}

function checkDelivery(paths, record, cli, herdr, plan) {
  const observed = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
  if (hostBusy(observed)) return record;
  const snapshot = requireActiveSnapshot(observed, paths, record, plan);
  if (snapshot.generation === record.cursor_generation) {
    if (snapshot.last_receipt_id !== record.cursor_receipt_id ||
        snapshot.turn !== record.cursor_turn)
      throw new Error("RECEIPT_CURSOR_MISMATCH");
    return record;
  }
  if (snapshot.generation !== record.cursor_generation + 1 ||
      !UUID.test(snapshot.last_receipt_id ?? "")) throw new Error("MISSED_RECEIPT");
  const result = call(cli, ["host", "receipt", "--project", paths.real,
    "--request-id", snapshot.last_receipt_id, "--json"]);
  if (hostBusy(result)) return record;
  const receipt = result.value;
  if (result.code !== 0 || receipt?.status !== "committed" ||
      receipt.request_id !== snapshot.last_receipt_id ||
      receipt.project_realpath !== paths.real || receipt.session_id !== record.session_id ||
      receipt.lease_id !== record.lease_id ||
      receipt.binding_generation !== record.binding_generation ||
      receipt.generation_before !== record.cursor_generation ||
      receipt.generation_after !== snapshot.generation ||
      receipt.role !== (record.cursor_turn === "ralph" ? "ralph" : "lisa") ||
      receipt.turn_after !== snapshot.turn || receipt.turn_after === receipt.role ||
      receipt.round_after !== snapshot.round || receipt.step_after !== snapshot.step ||
      receipt.state_digest_after !== snapshot.state_digest ||
      receipt.source_confirmation !== "human_asserted" ||
      receipt.source_verification !== "unverified")
    throw new Error(receipt?.code || "RECEIPT_MISMATCH");
  const role = receipt.turn_after;
  const message = `Ralph-Lisa committed handoff. Project: ${paths.real}. Session: ${record.session_id}. ` +
    `Receipt: ${receipt.request_id}. Generation: ${receipt.generation_after}. ` +
    `It is your ${role} turn in round ${receipt.round_after}. Read the current RLL state and ` +
    "work/review files before acting. Submit through the RLL host contract; preserve its human source confirmation gate.";
  const file = deliveryFile(paths, receipt.request_id);
  submitPrompt(paths, record, herdr, plan, role, message, file,
    { request_id: receipt.request_id, generation: receipt.generation_after });
  const next = { ...record, cursor_generation: receipt.generation_after,
    cursor_receipt_id: receipt.request_id, cursor_turn: role };
  durableWrite(paths.record, next);
  emit({ status: "handed_off", project: paths.real, request_id: receipt.request_id,
    generation: receipt.generation_after, role, pane_id: plan.seats[role].pane_id });
  return next;
}

function processControl(paths, record, cli, herdr, plan) {
  if (!fs.existsSync(paths.control)) return record;
  const request = readRecord(paths.control);
  if (request.owner_id !== record.owner_id || request.lease_id !== record.lease_id ||
      !UUID.test(request.request_id ?? "") ||
      !["pause", "resume"].includes(request.action))
    throw new Error("CONTROL_REQUEST_MISMATCH");
  if (record.control_request_id === request.request_id) {
    fs.unlinkSync(paths.control);
    return record;
  }
  const observed = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
  if (hostBusy(observed)) return record;
  const snapshot = requireActiveSnapshot(observed, paths, record, plan);
  if (request.action === "pause") {
    if (record.phase !== "active") throw new Error("PAUSE_STATE_CHANGED");
    record = { ...record, phase: "paused", control_request_id: request.request_id,
      paused_at: new Date().toISOString(), pause_state_digest: snapshot.state_digest,
      pause_round: snapshot.round, pause_step: snapshot.step,
      pause_generation: snapshot.generation, pause_receipt_id: snapshot.last_receipt_id,
      pause_turn: snapshot.turn, control_error: null };
  } else {
    if (record.phase !== "paused" || snapshot.generation !== record.cursor_generation ||
        snapshot.last_receipt_id !== record.cursor_receipt_id ||
        snapshot.turn !== record.cursor_turn ||
        snapshot.generation !== record.pause_generation ||
        snapshot.last_receipt_id !== record.pause_receipt_id ||
        snapshot.turn !== record.pause_turn ||
        snapshot.state_digest !== record.pause_state_digest ||
        snapshot.round !== record.pause_round || snapshot.step !== record.pause_step)
      throw new Error("RESUME_STATE_CHANGED");
    try {
      for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]])
        verifySeat(herdr, plan, role, kind);
    } catch (error) {
      if (error.message !== "AGENT_NOT_READY") throw error;
      record = { ...record, control_request_id: request.request_id,
        control_error: "AGENT_NOT_READY" };
      durableWrite(paths.record, record);
      fs.unlinkSync(paths.control);
      emit({ status: "not_ready", code: "AGENT_NOT_READY", project: paths.real,
        request_id: request.request_id });
      return record;
    }
    record = { ...record, phase: "active", control_request_id: request.request_id,
      paused_at: null, pause_state_digest: null, pause_round: null, pause_step: null,
      pause_generation: null, pause_receipt_id: null, pause_turn: null, control_error: null };
  }
  durableWrite(paths.record, record);
  fs.unlinkSync(paths.control);
  emit({ status: record.phase, project: paths.real, request_id: request.request_id,
    generation: record.cursor_generation });
  return record;
}

function verifySeat(herdr, plan, role, kind) {
  const result = call(herdr, ["agent", "get", role]);
  const agent = result.value?.result?.agent;
  const expected = plan.seats[role];
  let cwd = null;
  try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Fail closed. */ }
  if (result.code !== 0 || agent?.name !== role || agent?.agent !== kind ||
      agent?.workspace_id !== plan.workspace_id || agent?.pane_id !== expected.pane_id ||
      cwd !== plan.project_realpath) throw new Error("AGENT_CHANGED");
  if (!agent.interactive_ready || !["idle", "done"].includes(agent.agent_status))
    throw new Error("AGENT_NOT_READY");
}

function requireSnapshot(result) {
  const snapshot = result.value?.snapshot;
  if (result.code !== 0 || result.value?.status !== "ready" ||
      snapshot?.status !== "ok" ||
      !UUID.test(snapshot.session_id ?? "") ||
      typeof snapshot.project_realpath !== "string" ||
      !path.isAbsolute(snapshot.project_realpath) ||
      typeof snapshot.state_realpath !== "string" ||
      !path.isAbsolute(snapshot.state_realpath) ||
      typeof snapshot.state_digest !== "string") {
    throw new Error(result.value?.code || "PROJECT_NOT_READY");
  }
  if (snapshot.host_state !== "unclaimed") throw new Error("HOST_ALREADY_CLAIMED");
  return snapshot;
}

function requireHerdrResult(result, field, code) {
  if (result.code !== 0 || !result.value?.result?.[field])
    throw new Error(result.value?.error?.code || result.error || code);
  return result.value.result[field];
}

function missingAgent(herdr, role) {
  const result = call(herdr, ["agent", "get", role]);
  return result.code !== 0 && result.value?.error?.code === "agent_not_found";
}

async function waitForAgent(herdr, role, kind, workspaceId, paneId, project) {
  let announced = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = call(herdr, ["agent", "get", role]);
    const agent = result.value?.result?.agent;
    let cwd = null;
    try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Fail closed. */ }
    if (result.code !== 0 || agent?.name !== role || agent?.agent !== kind ||
        agent?.workspace_id !== workspaceId || agent?.pane_id !== paneId || cwd !== project)
      throw new Error("AGENT_START_MISMATCH");
    if (agent.interactive_ready && ["idle", "done"].includes(agent.agent_status)) return;
    if (!announced && agent.agent_status === "blocked") {
      emit({ status: "needs_input", code: "AGENT_BLOCKED", role,
        workspace_id: workspaceId, pane_id: paneId });
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("AGENT_READY_TIMEOUT");
}

async function launchAgent(herdr, role, kind, workspaceId, paneId, project) {
  const launched = call(herdr, ["agent", "start", role, "--kind", kind,
    "--pane", paneId, "--timeout", "60000"], { timeoutMs: 70000 });
  if (launched.code !== 0 && launched.value?.error?.code !== "agent_not_ready")
    throw new Error(launched.value?.error?.code || launched.error || "AGENT_START_FAILED");
  await waitForAgent(herdr, role, kind, workspaceId, paneId, project);
}

async function bootstrapSeats(paths, record, herdr) {
  if (!missingAgent(herdr, "ralph") || !missingAgent(herdr, "lisa"))
    throw new Error("EXISTING_AGENT_REQUIRES_REVIEW");
  const created = call(herdr, ["workspace", "create", "--cwd", paths.real,
    "--label", `Ralph-Lisa ${path.basename(paths.real)}`, "--focus"]);
  const workspaceId = created.value?.result?.workspace?.workspace_id;
  const rootPaneId = created.value?.result?.root_pane?.pane_id;
  if (created.code !== 0 || !workspaceId || !rootPaneId ||
      created.value?.result?.root_pane?.workspace_id !== workspaceId)
    throw new Error("WORKSPACE_CREATE_UNCERTAIN");
  record = { ...record, phase: "workspace_created", workspace_id: workspaceId,
    ralph_pane_id: rootPaneId };
  durableWrite(paths.record, record);
  await launchAgent(herdr, "ralph", "claude", workspaceId, rootPaneId, paths.real);
  record = { ...record, phase: "ralph_ready" };
  durableWrite(paths.record, record);
  const split = requireHerdrResult(call(herdr, ["pane", "split", rootPaneId,
    "--direction", "right", "--cwd", paths.real, "--focus"]),
  "pane", "PANE_SPLIT_UNCERTAIN");
  if (!split.pane_id || split.workspace_id !== workspaceId || split.pane_id === rootPaneId)
    throw new Error("PANE_SPLIT_UNCERTAIN");
  record = { ...record, phase: "pane_created", lisa_pane_id: split.pane_id };
  durableWrite(paths.record, record);
  await launchAgent(herdr, "lisa", "codex", workspaceId, split.pane_id, paths.real);
  record = { ...record, phase: "lisa_ready" };
  durableWrite(paths.record, record);
  const context = { workspace_id: workspaceId, workspace_cwd: paths.real };
  const preflight = call([process.execPath, path.join(root, "actions.mjs")],
    ["seat-preflight"], { env: { HERDR_WORKSPACE_ID: workspaceId,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context) } });
  if (preflight.code !== 0 || preflight.value?.status !== "ready" ||
      preflight.value?.binding_plan?.workspace_id !== workspaceId)
    throw new Error(preflight.value?.code || "BOOTSTRAP_PREFLIGHT_FAILED");
  return { plan: preflight.value.binding_plan, record };
}

async function start() {
  const status = call([process.execPath, path.join(root, "actions.mjs")], ["status"]);
  let initial;
  try { initial = requireSnapshot(status); }
  catch (error) {
    emit({ status: "not_ready", code: error.message || "PROJECT_NOT_READY" }, 3);
    return;
  }
  if (initial.generation !== null &&
      (initial.generation !== 0 || initial.last_receipt_id !== null)) {
    emit({ status: "not_ready", code: "EXISTING_GENERATION_REQUIRES_RECOVERY" }, 3);
    return;
  }
  let taskFile;
  try {
    if (initial.turn !== "ralph") throw new Error("INITIAL_TURN_REQUIRED");
    taskFile = requireTaskFile(initial);
  } catch (error) {
    emit({ status: "not_ready", code: error.message || "TASK_FILE_INVALID" }, 3);
    return;
  }
  const preflight = call([process.execPath, path.join(root, "actions.mjs")], ["seat-preflight"]);
  const bootNeeded = preflight.value?.code === "AGENT_MISSING";
  let plan = preflight.value?.status === "ready" ? preflight.value?.binding_plan : null;
  if (!plan && !bootNeeded) {
    emit({ status: "not_ready", code: preflight.value?.code || "SEAT_PREFLIGHT_FAILED" }, 3);
    return;
  }
  const paths = files(initial.project_realpath);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(initialFile(paths, initial.session_id))) {
    emit({ status: "not_ready", code: "INITIAL_PROMPT_REQUIRES_RECOVERY" }, 3);
    return;
  }
  const ownerId = crypto.randomUUID();
  let record = { schema: 1, phase: "intent", owner_id: ownerId, pid: process.pid,
    project_realpath: paths.real, session_id: initial.session_id,
    expected_digest: initial.state_digest, plan };
  try { durableWrite(paths.record, record, true); }
  catch (error) {
    emit({ status: "not_ready", code: error.code === "EEXIST" ? "COORDINATOR_EXISTS" : "STATE_WRITE_FAILED" }, 4);
    return;
  }
  const cli = config().cli;
  const herdr = [process.env.HERDR_BIN_PATH || "herdr"];
  try {
    if (bootNeeded) {
      const boot = await bootstrapSeats(paths, record, herdr);
      plan = boot.plan;
      record = { ...boot.record, phase: "seats_ready", plan };
      durableWrite(paths.record, record);
    }
    if (plan.project_realpath !== paths.real || plan.session_id !== initial.session_id ||
        plan.expected_digest !== initial.state_digest) throw new Error("PREFLIGHT_STATE_MISMATCH");
    const beforeClaim = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
    if (beforeClaim.code !== 0 || beforeClaim.value?.host_state !== "unclaimed" ||
        beforeClaim.value?.session_id !== initial.session_id ||
        beforeClaim.value?.state_digest !== initial.state_digest)
      throw new Error("STATE_CHANGED_BEFORE_CLAIM");
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
    const prepared = call(cli, ["host", "prepare-generation", "--project", paths.real,
      "--lease-id", lease.lease_id, "--expected-digest", current.value.state_digest, "--json"]);
    if (prepared.code !== 0 || prepared.value?.status !== "ready" ||
        prepared.value.session_id !== plan.session_id ||
        prepared.value.state_digest !== current.value.state_digest ||
        prepared.value.generation !== 0 || prepared.value.last_receipt_id !== null)
      throw new Error(prepared.value?.code || "GENERATION_BASELINE_UNCERTAIN");
    record = { ...record, phase: "active", binding_generation: current.value.binding_generation,
      cursor_generation: 0, cursor_receipt_id: null, cursor_turn: prepared.value.turn };
    durableWrite(paths.record, record);
    record = deliverInitial(paths, record, cli, herdr, plan, taskFile);
    emit({ status: "started", project: paths.real, workspace_id: plan.workspace_id,
      binding_generation: record.binding_generation, owner_id: ownerId, lease_id: lease.lease_id });
    let ticks = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (fs.existsSync(paths.stop) && fs.existsSync(paths.control))
        throw new Error("CONCURRENT_CONTROL_REQUESTS");
      if (fs.existsSync(paths.stop)) {
        const request = readRecord(paths.stop);
        if (request.owner_id !== ownerId || request.lease_id !== lease.lease_id)
          throw new Error("STOP_REQUEST_MISMATCH");
        const stoppedRead = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
        if (hostBusy(stoppedRead)) continue;
        const stoppedAt = requireActiveSnapshot(stoppedRead, paths, record, plan);
        if (stoppedAt.generation !== record.cursor_generation ||
            stoppedAt.last_receipt_id !== record.cursor_receipt_id)
          throw new Error("UNDELIVERED_RECEIPT_ON_STOP");
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
      record = processControl(paths, record, cli, herdr, plan);
      if (record.phase === "active") record = checkDelivery(paths, record, cli, herdr, plan);
      if (++ticks % 5 === 0) {
        const heartbeat = call(cli, ["host", "heartbeat", "--project", paths.real,
          "--lease-id", lease.lease_id, "--owner-id", ownerId, "--json"]);
        if (hostBusy(heartbeat)) continue;
        if (heartbeat.code !== 0 || heartbeat.value?.lease_id !== lease.lease_id)
          throw new Error(heartbeat.value?.code || "HEARTBEAT_UNCERTAIN");
      }
    }
  } catch (error) {
    let latest = record;
    try { latest = readRecord(paths.record); } catch { /* Keep the last in-memory intent. */ }
    failRecord(paths, latest, error.message || "COORDINATOR_ERROR");
  }
}

async function stop() {
  const project = projectFromContext();
  if (!project) { emit({ status: "not_ready", code: "PROJECT_REQUIRED" }, 3); return; }
  const paths = files(project);
  let record;
  try { record = readRecord(paths.record); }
  catch { emit({ status: "not_ready", code: "COORDINATOR_NOT_RUNNING" }, 4); return; }
  if (!["active", "paused"].includes(record.phase) || !UUID.test(record.lease_id ?? "")) {
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

async function control(action) {
  const project = projectFromContext();
  if (!project) { emit({ status: "not_ready", code: "PROJECT_REQUIRED" }, 3); return; }
  const paths = files(project);
  let record;
  try { record = readRecord(paths.record); }
  catch { emit({ status: "not_ready", code: "COORDINATOR_NOT_RUNNING" }, 4); return; }
  if (record.project_realpath !== paths.real || !UUID.test(record.lease_id ?? "") ||
      !["active", "paused"].includes(record.phase)) {
    emit({ status: "needs_reconcile", code: "COORDINATOR_NOT_ACTIVE" }, 7);
    return;
  }
  if (record.phase === (action === "pause" ? "paused" : "active")) {
    emit({ status: "not_ready", code: action === "pause" ? "ALREADY_PAUSED" : "ALREADY_ACTIVE",
      project: paths.real }, 4);
    return;
  }
  const requestId = crypto.randomUUID();
  try { durableWrite(paths.control, { action, request_id: requestId,
    owner_id: record.owner_id, lease_id: record.lease_id }, true); }
  catch (error) {
    emit({ status: "not_ready", code: error.code === "EEXIST" ?
      "CONTROL_PENDING" : "STATE_WRITE_FAILED" }, 4);
    return;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let current;
    try { current = readRecord(paths.record); }
    catch { break; }
    if (current.phase === "needs_reconcile") break;
    if (current.control_request_id === requestId && current.control_error) {
      emit({ status: "not_ready", code: current.control_error, project: paths.real,
        request_id: requestId }, 4);
      return;
    }
    if (current.control_request_id === requestId &&
        current.phase === (action === "pause" ? "paused" : "active")) {
      emit({ status: current.phase, project: paths.real, request_id: requestId,
        generation: current.cursor_generation });
      return;
    }
  }
  emit({ status: "needs_reconcile", code: "CONTROL_UNCONFIRMED", project: paths.real }, 7);
}

try {
  if (process.argv[2] === "start") await start();
  else if (process.argv[2] === "stop") await stop();
  else if (["pause", "resume"].includes(process.argv[2])) await control(process.argv[2]);
  else emit({ status: "error", code: "UNKNOWN_ACTION" }, 2);
} catch (error) {
  emit({ status: "error", code: error.message || "COORDINATOR_ERROR" }, 7);
}
