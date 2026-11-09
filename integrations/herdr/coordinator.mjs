import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeSessionReference } from "./native-session.mjs";
import { requireActiveSnapshot } from "./snapshot-diagnostic.mjs";
import { agentCliGuidance, resolveCliArgv } from "./cli-command.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emit(value, code = 0) {
  process.stdout.write(`${JSON.stringify({ schema: 1, ...value })}\n`);
  process.exitCode = code;
}

function waitForCoordinatorTick(signalState, delayMs) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (signalState?.wake === finish) signalState.wake = null;
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    if (signalState) {
      signalState.wake = finish;
      if (signalState.requested) finish();
    }
  });
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
  return { cli: resolveCliArgv(value.rll_cli_argv), project: value.project };
}

function projectFromContext() {
  const configured = config().project;
  let context = null;
  try { context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "null"); }
  catch { return null; }
  if (process.env.HERDR_WORKSPACE_ID && context?.workspace_id &&
      process.env.HERDR_WORKSPACE_ID !== context.workspace_id) return null;
  if (process.env.RLL_LAUNCH_REQUEST_ID) {
    if (!context?.workspace_id || !context?.workspace_cwd) return null;
    try {
      const real = fs.realpathSync.native(context.workspace_cwd);
      if (configured && fs.realpathSync.native(configured) !== real) return null;
      return real;
    } catch { return null; }
  }
  if (configured) return configured;
  return context?.workspace_cwd ?? null;
}

function launchFromContext() {
  const requestId = process.env.RLL_LAUNCH_REQUEST_ID;
  if (!requestId) return null;
  if (!UUID.test(requestId)) throw new Error("LAUNCH_REQUEST_INVALID");
  const project = projectFromContext();
  if (!project) throw new Error("LAUNCH_PROJECT_MISMATCH");
  const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "null");
  const state = path.join(project, ".dual-agent");
  const intent = readRecord(path.join(state, "herdr-launch-intent.json"));
  const workspace = readRecord(path.join(state, "herdr-launch-workspace.json"));
  const identity = readRecord(path.join(state, "session.json"));
  const taskSha = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(state, "task.md"))).digest("hex");
  if (intent.schema !== 1 || intent.request_id !== requestId ||
      intent.project_realpath !== project || intent.session_id !== identity.session_id ||
      identity.project_realpath !== project ||
      intent.task_sha256 !== taskSha || intent.auto_commit !== false ||
      !["interactive", "full_auto"].includes(intent.permission_profile) ||
      workspace.schema !== 1 || workspace.request_id !== requestId ||
      workspace.workspace_id !== context.workspace_id ||
      workspace.workspace_id !== process.env.HERDR_WORKSPACE_ID ||
      !workspace.root_pane_id || !workspace.root_terminal_id)
    throw new Error("LAUNCH_INTENT_MISMATCH");
  return { requestId, project, workspace, sessionId: intent.session_id,
    permissionProfile: intent.permission_profile };
}

function writeLaunchResult(launch, status, code) {
  if (!launch) return;
  const file = path.join(launch.project, ".dual-agent", "herdr-launch-result.json");
  const next = { schema: 1, request_id: launch.requestId, status,
    ...(code ? { code } : {}) };
  if (!fs.existsSync(file)) {
    durableWrite(file, next, true);
    return;
  }
  if (!launch.retryResult) throw new Error("LAUNCH_RESULT_EXISTS");
  const previous = readRecord(file);
  if (previous.schema !== 1 || previous.request_id !== launch.requestId ||
      !["not_ready", "needs_reconcile"].includes(previous.status))
    throw new Error("LAUNCH_RESULT_RETRY_MISMATCH");
  const archive = path.join(launch.project, ".dual-agent",
    `herdr-launch-result-${crypto.randomUUID()}.json`);
  durableWrite(archive, previous, true);
  durableWrite(file, next);
}

function files(project) {
  if (!stateRoot || !path.isAbsolute(stateRoot)) throw new Error("PLUGIN_STATE_DIR_REQUIRED");
  const real = fs.realpathSync.native(project);
  const key = crypto.createHash("sha256").update(real).digest("hex");
  const dir = path.join(stateRoot, "sessions", key);
  return { real, dir, record: path.join(dir, "record.json"),
    retryLock: path.join(dir, "preclaim-retry.lock"),
    stop: path.join(dir, "stop.json"), control: path.join(dir, "control.json"),
    rebind: path.join(dir, "rebind.pending.json"),
    continuation: path.join(dir, "continuation.pending.json") };
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

function priorDeliveryFiles(dir) {
  const names = fs.readdirSync(dir).filter((name) =>
    name.startsWith("initial-") || name.startsWith("delivery-")).sort();
  for (const name of names) {
    if (!/^(?:initial|delivery)-[0-9a-f-]{36}\.json$/i.test(name))
      throw new Error("PRIOR_DELIVERY_INVALID");
  }
  return names;
}

function priorPluginDigest(paths, names) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(readRecord(paths.record)));
  const add = (dir, record, files, depth) => {
    if (depth > 32) throw new Error("PRIOR_LINEAGE_DEPTH_EXCEEDED");
    for (const name of files)
      digest.update(name).update(JSON.stringify(readRecord(path.join(dir, name))));
    const archives = fs.readdirSync(dir).filter((name) => name.startsWith("prior-"));
    if (archives.length !== (record.prior_archive ? 1 : 0) ||
        (record.prior_archive && archives[0] !== record.prior_archive))
      throw new Error("PRIOR_LINEAGE_INVALID");
    if (record.prior_archive) {
      if (depth === 32 || record.prior_archive !== `prior-${record.prior_lease_id}`)
        throw new Error("PRIOR_LINEAGE_INVALID");
      const archive = path.join(dir, record.prior_archive);
      const stat = fs.lstatSync(archive);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("PRIOR_LINEAGE_INVALID");
      const prior = readRecord(path.join(archive, "record.json"));
      digest.update(record.prior_archive).update(JSON.stringify(prior));
      add(archive, prior, priorDeliveryFiles(archive), depth + 1);
    }
  };
  add(paths.dir, readRecord(paths.record), names, 0);
  return digest.digest("hex");
}

function failRecord(paths, record, error, fallback) {
  const code = error.message || fallback;
  const snapshotDiagnostic = error.snapshot_diagnostic;
  durableWrite(paths.record, { ...record, phase: "needs_reconcile", error: code,
    ...(snapshotDiagnostic ? { snapshot_diagnostic: snapshotDiagnostic } : {}) });
  emit({ status: "needs_reconcile", code, project: paths.real,
    ...(snapshotDiagnostic ? { snapshot_diagnostic: snapshotDiagnostic } : {}) }, 7);
}

function hostBusy(result) {
  return result.value?.code === "HOST_BUSY";
}

function deliveryFile(paths, requestId) {
  if (!UUID.test(requestId)) throw new Error("INVALID_RECEIPT_ID");
  return path.join(paths.dir, `delivery-${requestId.toLowerCase()}.json`);
}

function initialFile(paths, sessionId) {
  if (!UUID.test(sessionId)) throw new Error("INVALID_SESSION_ID");
  return path.join(paths.dir, `initial-${sessionId.toLowerCase()}.json`);
}

function initialPromptExists(paths, sessionId) {
  const name = path.basename(initialFile(paths, sessionId));
  const contains = (dir, depth) => {
    if (depth > 32) throw new Error("PRIOR_LINEAGE_DEPTH_EXCEEDED");
    if (fs.existsSync(path.join(dir, name))) return true;
    const archives = fs.readdirSync(dir).filter((entry) => entry.startsWith("prior-"));
    for (const entry of archives) {
      if (!/^prior-[0-9a-f-]{36}$/i.test(entry))
        throw new Error("PRIOR_DELIVERY_ARCHIVE_INVALID");
      const archive = path.join(dir, entry);
      const stat = fs.lstatSync(archive);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("PRIOR_DELIVERY_ARCHIVE_INVALID");
      if (contains(archive, depth + 1)) return true;
    }
    return false;
  };
  return contains(paths.dir, 0);
}

function submitPrompt(paths, record, herdr, plan, role, message, file, details) {
  verifySeat(herdr, plan, role, role === "ralph" ? "claude" : "codex");
  const intent = { schema: 1, status: "intent", owner_id: record.owner_id,
    lease_id: record.lease_id, role, workspace_id: plan.workspace_id,
    pane_id: plan.seats[role].pane_id, terminal_id: plan.seats[role].terminal_id,
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
  const nativeSession = observeSeat(herdr, plan, role,
    role === "ralph" ? "claude" : "codex", false);
  if (!plan.seats[role].native_session_fingerprint_sha256 &&
      nativeSession.status === "present")
    plan.seats[role].native_session_fingerprint_sha256 = nativeSession.fingerprint_sha256;
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
    "then work in the project. Prepare a separate RLL review candidate file; do not propose " +
    "the deliverable file as the candidate. This planning turn's candidate must start with " +
    "[PLAN] on its first line and include a Test Plan with a test command and coverage scope. " +
    "Propose that candidate through the RLL host contract and run its read-only commit-check " +
    "before requesting human review. " +
    `${agentCliGuidance(cli)} ` +
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
    `work/review files before acting. ${agentCliGuidance(cli)} ` +
    "Submit through the RLL host contract; preserve its human source confirmation gate.";
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

async function runActiveLoop(paths, initialRecord, cli, herdr, signalState = null) {
  let record = initialRecord;
  const plan = record.plan;
  const ownerId = record.owner_id;
  const leaseId = record.lease_id;
  let ticks = 0;
  let signalBusyChecks = 0;
  for (;;) {
    await waitForCoordinatorTick(signalState, 1000);
    if (fs.existsSync(paths.stop) && fs.existsSync(paths.control))
      throw new Error("CONCURRENT_CONTROL_REQUESTS");
    const signalStop = signalState?.requested === true;
    if (signalStop && fs.existsSync(paths.control))
      throw new Error("SIGNAL_SHUTDOWN_CONTROL_PENDING");
    if (fs.existsSync(paths.stop) || signalStop) {
      const request = fs.existsSync(paths.stop)
        ? readRecord(paths.stop) : { owner_id: ownerId, lease_id: leaseId };
      if (request.owner_id !== ownerId || request.lease_id !== leaseId)
        throw new Error("STOP_REQUEST_MISMATCH");
      const stoppedRead = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
      if (hostBusy(stoppedRead)) {
        if (signalStop && ++signalBusyChecks >= 5)
          throw new Error("SIGNAL_SHUTDOWN_HOST_BUSY");
        continue;
      }
      const stoppedAt = requireActiveSnapshot(stoppedRead, paths, record, plan);
      if (stoppedAt.generation !== record.cursor_generation ||
          stoppedAt.last_receipt_id !== record.cursor_receipt_id)
        throw new Error("UNDELIVERED_RECEIPT_ON_STOP");
      const released = call(cli, ["host", "release", "--project", paths.real,
        "--lease-id", leaseId, "--json"]);
      if (released.code !== 0 || released.value?.status !== "released")
        throw new Error(released.value?.code || "RELEASE_UNCERTAIN");
      record = { ...record, phase: "released",
        ...(signalStop ? { stop_reason: "managed_pane_closed" } : {}) };
      durableWrite(paths.record, record);
      fs.renameSync(paths.record, path.join(paths.dir, `finished-${ownerId}.json`));
      if (fs.existsSync(paths.stop)) fs.unlinkSync(paths.stop);
      emit({ status: "stopped", project: paths.real, owner_id: ownerId,
        ...(signalStop ? { reason: "managed_pane_closed" } : {}) });
      return;
    }
    record = processControl(paths, record, cli, herdr, plan);
    if (record.phase === "active") record = checkDelivery(paths, record, cli, herdr, plan);
    if (++ticks % 5 === 0) {
      for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]]) {
        const nativeSession = observeSeat(herdr, plan, role, kind, false);
        const prompted = role === "ralph" ? record.initial_status === "accepted"
          : record.cursor_generation > 0;
        if (prompted && !plan.seats[role].native_session_fingerprint_sha256 &&
            nativeSession.status === "present") {
          plan.seats[role].native_session_fingerprint_sha256 = nativeSession.fingerprint_sha256;
          durableWrite(paths.record, record);
        }
      }
      const heartbeat = call(cli, ["host", "heartbeat", "--project", paths.real,
        "--lease-id", leaseId, "--owner-id", ownerId, "--json"]);
      if (hostBusy(heartbeat)) continue;
      if (heartbeat.code !== 0 || heartbeat.value?.lease_id !== leaseId)
        throw new Error(heartbeat.value?.code || "HEARTBEAT_UNCERTAIN");
    }
  }
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

function observeSeat(herdr, plan, role, kind, requireReady) {
  const result = call(herdr, ["agent", "get", role]);
  const agent = result.value?.result?.agent;
  const expected = plan.seats[role];
  let cwd = null;
  try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Fail closed. */ }
  if (result.code !== 0 || agent?.name !== role || agent?.agent !== kind ||
      agent?.workspace_id !== plan.workspace_id || agent?.pane_id !== expected.pane_id ||
      cwd !== plan.project_realpath) throw new Error("AGENT_CHANGED");
  if (expected.terminal_id && agent.terminal_id !== expected.terminal_id)
    throw new Error("HERDR_TERMINAL_CHANGED");
  const nativeSession = nativeSessionReference(agent, kind);
  if (nativeSession.status === "invalid") throw new Error("AGENT_SESSION_INVALID");
  if (expected.native_session_fingerprint_sha256 &&
      nativeSession.fingerprint_sha256 !== expected.native_session_fingerprint_sha256)
    throw new Error("AGENT_SESSION_CHANGED");
  if (requireReady && (!agent.interactive_ready || !["idle", "done"].includes(agent.agent_status)))
    throw new Error("AGENT_NOT_READY");
  return nativeSession;
}

function verifySeat(herdr, plan, role, kind) {
  observeSeat(herdr, plan, role, kind, true);
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

function requireSavedPane(herdr, workspaceId, paneId, terminalId, project) {
  const result = call(herdr, ["pane", "get", paneId]);
  const pane = result.value?.result?.pane;
  let cwd = null;
  try { cwd = fs.realpathSync.native(pane.cwd); } catch { /* Fail closed. */ }
  if (result.code !== 0 || pane?.workspace_id !== workspaceId ||
      pane?.pane_id !== paneId || pane?.terminal_id !== terminalId ||
      cwd !== project) throw new Error("PRECLAIM_PANE_CHANGED");
  return pane;
}

function requireManagedPaneOpen(launch) {
  if (launch?.signalState?.requested) throw new Error("MANAGED_PANE_CLOSED_DURING_START");
}

async function waitForAgent(herdr, role, kind, workspaceId, paneId, project, terminalId,
  launch = null) {
  let announced = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    requireManagedPaneOpen(launch);
    const result = call(herdr, ["agent", "get", role]);
    const agent = result.value?.result?.agent;
    let cwd = null;
    try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Fail closed. */ }
    if (result.code !== 0 || agent?.name !== role || agent?.agent !== kind ||
        agent?.workspace_id !== workspaceId || agent?.pane_id !== paneId || cwd !== project ||
        (terminalId && agent?.terminal_id !== terminalId))
      throw new Error("AGENT_START_MISMATCH");
    if (agent.interactive_ready && ["idle", "done"].includes(agent.agent_status)) return;
    if (!announced && agent.agent_status === "blocked") {
      emit({ status: "needs_input", code: "AGENT_BLOCKED", role,
        workspace_id: workspaceId, pane_id: paneId });
      announced = true;
    }
    await waitForCoordinatorTick(launch?.signalState, 1000);
  }
  throw new Error("AGENT_READY_TIMEOUT");
}

async function launchAgent(herdr, role, kind, workspaceId, paneId, project, terminalId,
  permissionProfile = null, launch = null) {
  const agentArgs = permissionProfile === null ? [] : kind === "codex"
    ? permissionProfile === "full_auto"
      ? ["--no-daemon", "--sandbox", "workspace-write", "--ask-for-approval", "never"]
      : ["--no-daemon"]
    : permissionProfile === "full_auto" ? ["--dangerously-skip-permissions"] : [];
  for (let attempt = 0; attempt < 12; attempt++) {
    requireManagedPaneOpen(launch);
    const launched = call(herdr, ["agent", "start", role, "--kind", kind,
      "--pane", paneId, "--timeout", "60000",
      ...(agentArgs.length ? ["--", ...agentArgs] : [])], { timeoutMs: 70000 });
    const code = launched.value?.error?.code;
    if (launched.code === 0 || code === "agent_not_ready") {
      await waitForAgent(herdr, role, kind, workspaceId, paneId, project, terminalId, launch);
      return;
    }
    if (code !== "agent_pane_busy" || !terminalId)
      throw new Error(code || launched.error || "AGENT_START_FAILED");
    const pane = requireSavedPane(herdr, workspaceId, paneId, terminalId, project);
    const observed = call(herdr, ["agent", "get", role]);
    if (observed.code === 0) {
      await waitForAgent(herdr, role, kind, workspaceId, paneId, project, terminalId, launch);
      return;
    }
    if (observed.value?.error?.code !== "agent_not_found" || pane.agent)
      throw new Error("AGENT_PANE_BUSY_UNCERTAIN");
    if (attempt === 11) throw new Error("agent_pane_busy");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function bootstrapSeats(paths, record, herdr, launch = null) {
  requireManagedPaneOpen(launch);
  if (!missingAgent(herdr, "ralph") || !missingAgent(herdr, "lisa"))
    throw new Error("EXISTING_AGENT_REQUIRES_REVIEW");
  let workspaceId, rootPaneId, rootTerminalId;
  if (launch) {
    workspaceId = launch.workspace.workspace_id;
    rootPaneId = launch.workspace.root_pane_id;
    rootTerminalId = launch.workspace.root_terminal_id;
    const observed = call(herdr, ["workspace", "get", workspaceId]);
    if (observed.code !== 0 ||
        observed.value?.result?.workspace?.workspace_id !== workspaceId)
      throw new Error("LAUNCH_WORKSPACE_MISMATCH");
    requireSavedPane(herdr, workspaceId, rootPaneId, rootTerminalId, paths.real);
  } else {
    const created = call(herdr, ["workspace", "create", "--cwd", paths.real,
      "--label", `Ralph-Lisa ${path.basename(paths.real)}`, "--focus"]);
    workspaceId = created.value?.result?.workspace?.workspace_id;
    rootPaneId = created.value?.result?.root_pane?.pane_id;
    rootTerminalId = created.value?.result?.root_pane?.terminal_id ?? null;
    if (created.code !== 0 || !workspaceId || !rootPaneId ||
        created.value?.result?.root_pane?.workspace_id !== workspaceId)
      throw new Error("WORKSPACE_CREATE_UNCERTAIN");
  }
  record = { ...record, phase: "workspace_created", workspace_id: workspaceId,
    ralph_pane_id: rootPaneId,
    ralph_terminal_id: rootTerminalId };
  durableWrite(paths.record, record);
  record = { ...record, phase: "ralph_start_pending", ralph_start_attempted: true };
  durableWrite(paths.record, record);
  await launchAgent(herdr, "ralph", "claude", workspaceId, rootPaneId, paths.real,
    record.ralph_terminal_id, launch?.permissionProfile, launch);
  requireManagedPaneOpen(launch);
  record = { ...record, phase: "ralph_ready" };
  durableWrite(paths.record, record);
  const split = requireHerdrResult(call(herdr, ["pane", "split", rootPaneId,
    "--direction", "right", "--cwd", paths.real, "--focus"]),
  "pane", "PANE_SPLIT_UNCERTAIN");
  if (!split.pane_id || split.workspace_id !== workspaceId || split.pane_id === rootPaneId)
    throw new Error("PANE_SPLIT_UNCERTAIN");
  record = { ...record, phase: "pane_created", lisa_pane_id: split.pane_id,
    lisa_terminal_id: split.terminal_id ?? null };
  durableWrite(paths.record, record);
  record = { ...record, phase: "lisa_start_pending", lisa_start_attempted: true };
  durableWrite(paths.record, record);
  await launchAgent(herdr, "lisa", "codex", workspaceId, split.pane_id, paths.real,
    record.lisa_terminal_id, launch?.permissionProfile, launch);
  requireManagedPaneOpen(launch);
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

function oldCoordinatorPresent(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function claimPreclaimRetry(paths, initial) {
  try { durableWrite(paths.retryLock, { schema: 1, pid: process.pid }, true); }
  catch (error) {
    throw new Error(error.code === "EEXIST" ? "PRECLAIM_RETRY_IN_PROGRESS" : "RETRY_LOCK_FAILED");
  }
  try {
    const names = fs.readdirSync(paths.dir).sort();
    if (names.length !== 2 || names[0] !== "preclaim-retry.lock" ||
        names[1] !== "record.json" || initial.generation !== null ||
        initial.last_receipt_id !== null)
      throw new Error("PRECLAIM_STATE_REQUIRES_REVIEW");
    const old = readRecord(paths.record);
    if (old.schema !== 1 || old.project_realpath !== paths.real ||
        old.session_id !== initial.session_id || old.expected_digest !== initial.state_digest ||
        !UUID.test(old.owner_id ?? "") || !Number.isSafeInteger(old.pid) || old.pid <= 0 ||
        old.plan != null || old.lease_id != null ||
        !["intent", "workspace_created", "ralph_start_pending", "ralph_ready",
          "pane_created", "lisa_start_pending", "lisa_ready", "needs_reconcile"].includes(old.phase) ||
        (old.workspace_id && (!old.ralph_pane_id || !old.ralph_terminal_id)) ||
        (old.lisa_pane_id && (!old.workspace_id || !old.lisa_terminal_id)) ||
        (!old.workspace_id && (old.ralph_pane_id || old.lisa_pane_id)))
      throw new Error("PRECLAIM_RECORD_REQUIRES_REVIEW");
    if (oldCoordinatorPresent(old.pid)) throw new Error("COORDINATOR_EXISTS");
    const record = { ...old, phase: "preclaim_retry", pid: process.pid };
    durableWrite(paths.record, record);
    return record;
  } finally {
    fs.unlinkSync(paths.retryLock);
  }
}

async function resumePreclaimSeats(paths, record, herdr, launch = null) {
  requireManagedPaneOpen(launch);
  if (!record.workspace_id) return bootstrapSeats(paths, record, herdr, launch);
  const workspaceId = record.workspace_id;
  const workspace = call(herdr, ["workspace", "get", workspaceId]);
  if (workspace.code !== 0 ||
      workspace.value?.result?.workspace?.workspace_id !== workspaceId)
    throw new Error("PRECLAIM_WORKSPACE_CHANGED");
  const ralphPane = requireSavedPane(herdr, workspaceId, record.ralph_pane_id,
    record.ralph_terminal_id, paths.real);
  if (missingAgent(herdr, "ralph")) {
    if ((record.ralph_start_attempted && record.error !== "agent_pane_busy") ||
        ralphPane.agent)
      throw new Error("PRECLAIM_RALPH_MISSING_REQUIRES_REVIEW");
    record = { ...record, phase: "ralph_start_pending", ralph_start_attempted: true };
    durableWrite(paths.record, record);
    await launchAgent(herdr, "ralph", "claude", workspaceId, record.ralph_pane_id,
      paths.real, record.ralph_terminal_id, launch?.permissionProfile, launch);
  } else {
    await waitForAgent(herdr, "ralph", "claude", workspaceId,
      record.ralph_pane_id, paths.real, record.ralph_terminal_id, launch);
  }
  requireManagedPaneOpen(launch);
  record = { ...record, phase: "ralph_ready" };
  durableWrite(paths.record, record);
  if (!record.lisa_pane_id) {
    const split = requireHerdrResult(call(herdr, ["pane", "split", record.ralph_pane_id,
      "--direction", "right", "--cwd", paths.real, "--focus"]),
    "pane", "PANE_SPLIT_UNCERTAIN");
    if (!split.pane_id || split.workspace_id !== workspaceId ||
        split.pane_id === record.ralph_pane_id || !split.terminal_id)
      throw new Error("PANE_SPLIT_UNCERTAIN");
    record = { ...record, phase: "pane_created", lisa_pane_id: split.pane_id,
      lisa_terminal_id: split.terminal_id };
    durableWrite(paths.record, record);
  }
  const lisaPane = requireSavedPane(herdr, workspaceId, record.lisa_pane_id,
    record.lisa_terminal_id, paths.real);
  if (missingAgent(herdr, "lisa")) {
    if ((record.lisa_start_attempted && record.error !== "agent_pane_busy") || lisaPane.agent)
      throw new Error("PRECLAIM_LISA_MISSING_REQUIRES_REVIEW");
    record = { ...record, phase: "lisa_start_pending", lisa_start_attempted: true };
    durableWrite(paths.record, record);
    await launchAgent(herdr, "lisa", "codex", workspaceId, record.lisa_pane_id,
      paths.real, record.lisa_terminal_id, launch?.permissionProfile, launch);
  } else {
    await waitForAgent(herdr, "lisa", "codex", workspaceId,
      record.lisa_pane_id, paths.real, record.lisa_terminal_id, launch);
  }
  requireManagedPaneOpen(launch);
  record = { ...record, phase: "lisa_ready", error: undefined };
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
  let launch = null;
  try { launch = launchFromContext(); }
  catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error.message ?? "") ? error.message : "LAUNCH_INTENT_INVALID";
    emit({ status: "not_ready", code }, 3);
    return;
  }
  const stopLaunch = (status, code, exitCode) => {
    try { writeLaunchResult(launch, status, code); }
    catch { emit({ status: "needs_reconcile", code: "LAUNCH_RESULT_WRITE_FAILED" }, 7); return; }
    emit({ status, code }, exitCode);
  };
  const status = call([process.execPath, path.join(root, "actions.mjs")], ["status"]);
  let initial;
  try { initial = requireSnapshot(status); }
  catch (error) {
    stopLaunch("not_ready", error.message || "PROJECT_NOT_READY", 3);
    return;
  }
  if (launch && (initial.project_realpath !== launch.project ||
      initial.session_id !== launch.sessionId)) {
    stopLaunch("not_ready", "LAUNCH_SESSION_MISMATCH", 3);
    return;
  }
  if (initial.generation !== null &&
      (initial.generation !== 0 || initial.last_receipt_id !== null)) {
    stopLaunch("not_ready", "EXISTING_GENERATION_REQUIRES_RECOVERY", 3);
    return;
  }
  let taskFile;
  try {
    if (initial.turn !== "ralph") throw new Error("INITIAL_TURN_REQUIRED");
    taskFile = requireTaskFile(initial);
  } catch (error) {
    stopLaunch("not_ready", error.message || "TASK_FILE_INVALID", 3);
    return;
  }
  const paths = files(initial.project_realpath);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (initialPromptExists(paths, initial.session_id)) {
    stopLaunch("not_ready", "INITIAL_PROMPT_REQUIRES_RECOVERY", 3);
    return;
  }
  let record;
  let plan = null;
  let bootNeeded = false;
  const retry = fs.existsSync(paths.record);
  try {
    if (retry) {
      record = claimPreclaimRetry(paths, initial);
      if (launch) launch.retryResult = true;
    } else {
      if (fs.readdirSync(paths.dir).length !== 0)
        throw new Error("PRECLAIM_STATE_REQUIRES_REVIEW");
      const preflight = call([process.execPath, path.join(root, "actions.mjs")], ["seat-preflight"]);
      bootNeeded = preflight.value?.code === "AGENT_MISSING";
      plan = preflight.value?.status === "ready" ? preflight.value?.binding_plan : null;
      if (!plan && !bootNeeded) {
        stopLaunch("not_ready", preflight.value?.code || "SEAT_PREFLIGHT_FAILED", 3);
        return;
      }
      record = { schema: 1, phase: "intent", owner_id: crypto.randomUUID(), pid: process.pid,
        project_realpath: paths.real, session_id: initial.session_id,
        expected_digest: initial.state_digest, plan };
      try { durableWrite(paths.record, record, true); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error("COORDINATOR_EXISTS");
        throw error;
      }
    }
  } catch (error) {
    stopLaunch("not_ready", error.message || "STATE_WRITE_FAILED", 4);
    return;
  }
  const ownerId = record.owner_id;
  const cli = config().cli;
  const herdr = [process.env.HERDR_BIN_PATH || "herdr"];
  const signalState = launch ? { requested: false } : null;
  if (launch) launch.signalState = signalState;
  const onSignal = () => {
    if (signalState) {
      signalState.requested = true;
      signalState.wake?.();
    }
  };
  if (signalState) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    process.on("SIGHUP", onSignal);
  }
  try {
    if (retry || bootNeeded) {
      const boot = retry
        ? await resumePreclaimSeats(paths, record, herdr, launch)
        : await bootstrapSeats(paths, record, herdr, launch);
      plan = boot.plan;
      record = { ...boot.record, phase: "seats_ready", plan };
      durableWrite(paths.record, record);
    }
    requireManagedPaneOpen(launch);
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
    // A managed Pane may close while synchronous claim/bind commands are running.
    // Let queued signals run before creating the irreversible initial prompt intent.
    if (launch) await new Promise((resolve) => setTimeout(resolve, 0));
    requireManagedPaneOpen(launch);
    record = deliverInitial(paths, record, cli, herdr, plan, taskFile);
    writeLaunchResult(launch, "started");
    emit({ status: "started", project: paths.real, workspace_id: plan.workspace_id,
      binding_generation: record.binding_generation, owner_id: ownerId, lease_id: lease.lease_id });
    await runActiveLoop(paths, record, cli, herdr, signalState);
  } catch (error) {
    let latest = record;
    try { latest = readRecord(paths.record); } catch { /* Keep the last in-memory intent. */ }
    try { writeLaunchResult(launch, "needs_reconcile", error.message || "COORDINATOR_ERROR"); }
    catch { /* Existing result stays immutable; plugin record carries the failure. */ }
    failRecord(paths, latest, error, "COORDINATOR_ERROR");
  } finally {
    if (signalState) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      process.off("SIGHUP", onSignal);
    }
  }
}

async function stop() {
  const project = projectFromContext();
  if (!project) { emit({ status: "not_ready", code: "PROJECT_REQUIRED" }, 3); return; }
  const paths = files(project);
  let record;
  try { record = readRecord(paths.record); }
  catch { emit({ status: "not_ready", code: "COORDINATOR_NOT_RUNNING" }, 4); return; }
  if (fs.existsSync(paths.continuation)) {
    emit({ status: "needs_reconcile", code: "CONTINUATION_PENDING_REVIEW",
      project: paths.real }, 7);
    return;
  }
  if (record.phase === "rebound_paused") {
    try {
      if (fs.existsSync(paths.rebind)) throw new Error("REBIND_PENDING_REVIEW");
      const cli = config().cli;
      const observed = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
      const snapshot = requireActiveSnapshot(observed, paths, record, record.plan);
      if (snapshot.generation !== record.cursor_generation ||
          snapshot.last_receipt_id !== record.cursor_receipt_id ||
          snapshot.turn !== record.cursor_turn ||
          snapshot.state_digest !== record.pause_state_digest)
        throw new Error("REBOUND_STATE_CHANGED");
      const finished = path.join(paths.dir, `finished-${record.owner_id}.json`);
      if (fs.existsSync(finished)) throw new Error("FINISHED_RECORD_EXISTS");
      const released = call(cli, ["host", "release", "--project", paths.real,
        "--lease-id", record.lease_id, "--json"]);
      if (released.code !== 0 || released.value?.status !== "released")
        throw new Error(released.value?.code || "RELEASE_UNCERTAIN");
      fs.renameSync(paths.record, finished);
      emit({ status: "stopped", project: paths.real, owner_id: record.owner_id,
        replay: "not_replayed" });
    } catch (error) {
      emit({ status: "needs_reconcile", code: error.message || "REBOUND_STOP_UNCERTAIN",
        project: paths.real,
        ...(error.snapshot_diagnostic ?
          { snapshot_diagnostic: error.snapshot_diagnostic } : {}) }, 7);
    }
    return;
  }
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

async function continueRebound(expectedEvidence, decision) {
  if (!/^[0-9a-f]{64}$/.test(expectedEvidence ?? "") ||
      decision !== "reviewed-cursor-no-replay") {
    emit({ status: "not_ready", code: "CONTINUATION_CONFIRMATION_REQUIRED" }, 2);
    return;
  }
  const checked = call([process.execPath, path.join(root, "actions.mjs")],
    ["continuation-check"]);
  const review = checked.value;
  if (checked.code !== 0 || review?.status !== "review_required" ||
      review.evidence_sha256 !== expectedEvidence ||
      review.continuation_blockers?.length !== 0) {
    emit({ status: "not_ready", code: review?.code || "CONTINUATION_EVIDENCE_CHANGED" }, 4);
    return;
  }
  const paths = files(review.project);
  let record = readRecord(paths.record);
  if (record.phase !== "rebound_paused" || record.lease_id !== review.lease_id ||
      record.session_id !== review.session_id ||
      record.binding_generation !== review.binding_generation ||
      record.cursor_generation !== review.generation ||
      record.cursor_receipt_id !== review.last_receipt_id ||
      record.cursor_turn !== review.turn || !UUID.test(record.owner_id ?? "")) {
    emit({ status: "needs_reconcile", code: "REBOUND_RECORD_CHANGED",
      project: paths.real }, 7);
    return;
  }
  const originalRecord = JSON.stringify(record);
  const cli = config().cli;
  const herdr = [process.env.HERDR_BIN_PATH || "herdr"];
  try {
    durableWrite(paths.continuation, { schema: 1, status: "intent",
      owner_id: record.owner_id, lease_id: record.lease_id,
      expected_evidence: expectedEvidence, cursor_generation: record.cursor_generation,
      cursor_receipt_id: record.cursor_receipt_id, replay: "not_replayed" }, true);
  } catch (error) {
    emit({ status: "not_ready", code: error.code === "EEXIST" ?
      "CONTINUATION_PENDING_REVIEW" : "STATE_WRITE_FAILED", project: paths.real }, 4);
    return;
  }
  try {
    if (JSON.stringify(readRecord(paths.record)) !== originalRecord ||
        fs.existsSync(paths.stop) || fs.existsSync(paths.control) ||
        fs.existsSync(paths.rebind))
      throw new Error("CONTINUATION_STATE_CHANGED");
    const observed = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
    const snapshot = requireActiveSnapshot(observed, paths, record, record.plan);
    if (snapshot.generation !== record.cursor_generation ||
        snapshot.last_receipt_id !== record.cursor_receipt_id ||
        snapshot.turn !== record.cursor_turn ||
        snapshot.state_digest !== record.pause_state_digest)
      throw new Error("CONTINUATION_STATE_CHANGED");
    for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]])
      verifySeat(herdr, record.plan, role, kind);
    const heartbeat = call(cli, ["host", "heartbeat", "--project", paths.real,
      "--lease-id", record.lease_id, "--owner-id", record.owner_id, "--json"]);
    if (heartbeat.code !== 0 || heartbeat.value?.lease_id !== record.lease_id)
      throw new Error(heartbeat.value?.code || "CONTINUATION_HEARTBEAT_UNCERTAIN");
    record = { ...record, phase: "active", pid: process.pid,
      inherited_cursor_generation: record.cursor_generation,
      inherited_cursor_receipt_id: record.cursor_receipt_id,
      inherited_cursor_turn: record.cursor_turn,
      continuation_evidence_sha256: expectedEvidence,
      continued_at: new Date().toISOString(), paused_at: null,
      pause_state_digest: null, pause_generation: null,
      pause_receipt_id: null, pause_turn: null, pause_round: null, pause_step: null };
    durableWrite(paths.record, record);
    fs.unlinkSync(paths.continuation);
    emit({ status: "continued", project: paths.real, lease_id: record.lease_id,
      owner_id: record.owner_id, generation: record.cursor_generation,
      replay: "not_replayed" });
    await runActiveLoop(paths, record, cli, herdr);
  } catch (error) {
    let latest = record;
    try { latest = readRecord(paths.record); } catch { /* Preserve latest known state. */ }
    failRecord(paths, latest, error, "CONTINUATION_UNCERTAIN");
  }
}

async function rebind(expectedEvidence, decision) {
  if (!/^[0-9a-f]{64}$/.test(expectedEvidence ?? "") ||
      decision !== "verified-seats-no-replay") {
    emit({ status: "not_ready", code: "REBIND_CONFIRMATION_REQUIRED" }, 2);
    return;
  }
  const checked = call([process.execPath, path.join(root, "actions.mjs")], ["rebind-check"]);
  const review = checked.value;
  if (checked.code !== 0 || review?.status !== "review_required" ||
      review.evidence_sha256 !== expectedEvidence ||
      review.continuation_blockers?.length !== 0) {
    emit({ status: "not_ready", code: review?.code || "REBIND_EVIDENCE_CHANGED" }, 4);
    return;
  }
  const paths = files(review.project);
  const old = readRecord(paths.record);
  if (old.phase !== review.old_phase ||
      !["needs_reconcile", "paused"].includes(old.phase) ||
      old.lease_id !== review.old_lease_id ||
      old.session_id !== review.session_id || !UUID.test(old.owner_id ?? "")) {
    emit({ status: "needs_reconcile", code: "OLD_COORDINATOR_CHANGED" }, 7);
    return;
  }
  const plan = review.binding_plan;
  const cli = config().cli;
  const herdr = [process.env.HERDR_BIN_PATH || "herdr"];
  const ownerId = crypto.randomUUID();
  let lease = null;
  try {
    durableWrite(paths.rebind, { schema: 1, status: "intent", old_lease_id: old.lease_id,
      recovery_id: review.recovery_id, expected_evidence: expectedEvidence,
      owner_id: ownerId, replay: "not_replayed" }, true);
    const before = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
    if (before.code !== 0 || before.value?.host_state !== "unclaimed" ||
        before.value.session_id !== review.session_id ||
        before.value.state_digest !== plan.expected_digest ||
        before.value.generation !== review.generation ||
        before.value.last_receipt_id !== review.last_receipt_id ||
        before.value.turn !== review.turn)
      throw new Error("REBIND_STATE_CHANGED");
    for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]])
      verifySeat(herdr, plan, role, kind);
    const claimed = call(cli, ["host", "claim", "--project", paths.real,
      "--host", "herdr", "--owner-id", ownerId, "--json"]);
    lease = claimed.value;
    if (claimed.code !== 0 || lease?.status !== "claimed" ||
        !UUID.test(lease.lease_id ?? "") || lease.session_id !== review.session_id)
      throw new Error(claimed.value?.code || "REBIND_CLAIM_UNCERTAIN");
    durableWrite(paths.rebind, { schema: 1, status: "claimed", old_lease_id: old.lease_id,
      recovery_id: review.recovery_id, new_lease_id: lease.lease_id,
      owner_id: ownerId, replay: "not_replayed" });
    for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]]) {
      verifySeat(herdr, plan, role, kind);
      const seat = plan.seats[role];
      const bound = call(cli, ["host", "bind-seat", "--project", paths.real,
        "--lease-id", lease.lease_id, "--role", role,
        "--workspace-id", plan.workspace_id, "--pane-id", seat.pane_id,
        "--agent-target", seat.agent_target, "--json"]);
      if (bound.code !== 0 || bound.value?.status !== "bound" ||
          bound.value.lease_id !== lease.lease_id)
        throw new Error(bound.value?.code || "REBIND_BIND_UNCERTAIN");
    }
    const current = call(cli, ["host", "snapshot", "--project", paths.real, "--json"]);
    if (current.code !== 0 || current.value?.host_state !== "claimed" ||
        current.value.owner_id !== ownerId || current.value.binding_state !== "bound" ||
        current.value.session_id !== review.session_id ||
        current.value.state_digest !== plan.expected_digest ||
        current.value.generation !== review.generation ||
        current.value.last_receipt_id !== review.last_receipt_id ||
        current.value.turn !== review.turn ||
        current.value.workspace_id !== plan.workspace_id ||
        current.value.seats?.ralph?.pane_id !== plan.seats.ralph.pane_id ||
        current.value.seats?.lisa?.pane_id !== plan.seats.lisa.pane_id)
      throw new Error("REBIND_SNAPSHOT_MISMATCH");
    const prepared = call(cli, ["host", "prepare-generation", "--project", paths.real,
      "--lease-id", lease.lease_id, "--expected-digest", current.value.state_digest,
      "--json"]);
    if (prepared.code !== 0 || prepared.value?.status !== "ready" ||
        prepared.value.generation !== review.generation ||
        prepared.value.last_receipt_id !== review.last_receipt_id ||
        prepared.value.turn !== review.turn)
      throw new Error(prepared.value?.code || "REBIND_GENERATION_MISMATCH");
    for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]])
      verifySeat(herdr, plan, role, kind);
    const priorFiles = priorDeliveryFiles(paths.dir);
    if (priorPluginDigest(paths, priorFiles) !== review.plugin_evidence_sha256)
      throw new Error("PRIOR_DELIVERY_CHANGED");
    const archive = path.join(paths.dir, `prior-${old.lease_id}`);
    fs.mkdirSync(archive, { mode: 0o700 });
    for (const name of priorFiles)
      fs.renameSync(path.join(paths.dir, name), path.join(archive, name));
    if (old.prior_archive)
      fs.renameSync(path.join(paths.dir, old.prior_archive),
        path.join(archive, old.prior_archive));
    fs.renameSync(paths.record, path.join(archive, "record.json"));
    const rebound = { schema: 1, phase: "rebound_paused", pid: process.pid,
      owner_id: ownerId, lease_id: lease.lease_id, project_realpath: paths.real,
      session_id: review.session_id, expected_digest: plan.expected_digest,
      plan, binding_generation: current.value.binding_generation,
      cursor_generation: review.generation, cursor_receipt_id: review.last_receipt_id,
      cursor_turn: review.turn, pause_state_digest: plan.expected_digest,
      pause_generation: review.generation, pause_receipt_id: review.last_receipt_id,
      pause_turn: review.turn, prior_lease_id: old.lease_id,
      prior_recovery_id: review.recovery_id, prior_archive: path.basename(archive),
      initial_status: "inherited_accepted", replay: "not_replayed" };
    durableWrite(paths.record, rebound, true);
    fs.unlinkSync(paths.rebind);
    emit({ status: "rebound_paused", project: paths.real, lease_id: lease.lease_id,
      owner_id: ownerId, binding_generation: rebound.binding_generation,
      generation: review.generation, replay: "not_replayed" });
  } catch (error) {
    emit({ status: "needs_reconcile", code: error.message || "REBIND_UNCERTAIN",
      project: paths.real, lease_id: lease?.lease_id ?? null,
      note: "The rebind intent remains for manual review; no Agent prompt was sent." }, 7);
  }
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
  else if (process.argv[2] === "rebind") await rebind(process.argv[3], process.argv[4]);
  else if (process.argv[2] === "continue")
    await continueRebound(process.argv[3], process.argv[4]);
  else if (["pause", "resume"].includes(process.argv[2])) await control(process.argv[2]);
  else emit({ status: "error", code: "UNKNOWN_ACTION" }, 2);
} catch (error) {
  emit({ status: "error", code: error.message || "COORDINATOR_ERROR" }, 7);
}
