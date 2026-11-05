import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeSessionReference } from "./native-session.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const MIN_HERDR = [0, 9, 4];
const ACTIONS = new Set(["doctor", "status", "seat-preflight", "recovery-check", "rebind-check", "continuation-check"]);
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

function regularDirectory(dir, code) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        fs.realpathSync.native(dir) !== dir) throw new Error("invalid directory");
  } catch { throw new Error(code); }
}

function entryExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function validatePluginPlan(plan, projectRealpath, sessionId) {
  if (!plan || plan.project_realpath !== projectRealpath ||
      plan.session_id !== sessionId ||
      typeof plan.workspace_id !== "string" || !plan.workspace_id ||
      typeof plan.seats?.ralph?.pane_id !== "string" ||
      typeof plan.seats?.lisa?.pane_id !== "string" ||
      plan.seats.ralph.pane_id === plan.seats.lisa.pane_id)
    throw new Error("PLUGIN_BINDING_MISMATCH");
  for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]]) {
    const seat = plan.seats[role];
    const fingerprint = seat.native_session_fingerprint_sha256;
    if (seat.agent_kind !== kind ||
        (seat.terminal_id !== undefined &&
          (typeof seat.terminal_id !== "string" || !seat.terminal_id)) ||
        (fingerprint !== undefined && fingerprint !== null &&
          !/^[0-9a-f]{64}$/.test(fingerprint)))
      throw new Error("PLUGIN_BINDING_MISMATCH");
  }
}

function readDeliveryRecords(dir, record, plan, digest) {
  const names = fs.readdirSync(dir).filter((name) =>
    name.startsWith("initial-") || name.startsWith("delivery-")).sort();
  const deliveries = names.map((name) => {
    if (!/^(?:initial|delivery)-[0-9a-f-]{36}\.json$/i.test(name))
      throw new Error("PLUGIN_DELIVERY_INVALID");
    const value = regularJson(path.join(dir, name), "PLUGIN_DELIVERY_INVALID");
    digest.update(name).update(JSON.stringify(value));
    if (!UUID.test(name.slice(name.indexOf("-") + 1, -5)) ||
        !["intent", "accepted"].includes(value.status) ||
        value.owner_id !== record.owner_id || value.lease_id !== record.lease_id ||
        !["ralph", "lisa"].includes(value.role) ||
        value.workspace_id !== plan.workspace_id ||
        value.pane_id !== plan.seats[value.role]?.pane_id ||
        (plan.seats[value.role]?.terminal_id &&
          value.terminal_id !== plan.seats[value.role].terminal_id) ||
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
  });
  return deliveries.sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
}

function recoverableCoordinatorPhase(record, stateDigest, generation,
  receiptId, turn) {
  if (record.phase === "needs_reconcile") return true;
  return record.phase === "paused" &&
    typeof record.paused_at === "string" && !!record.paused_at &&
    record.pause_state_digest === stateDigest &&
    record.pause_generation === generation &&
    record.pause_receipt_id === receiptId &&
    record.pause_turn === turn &&
    record.cursor_generation === generation &&
    record.cursor_receipt_id === receiptId &&
    record.cursor_turn === turn;
}

function readLineageDeliveries(dir, record, projectRealpath, digest, depth = 0) {
  if (depth > 32) throw new Error("PLUGIN_LINEAGE_DEPTH_EXCEEDED");
  const plan = record.plan;
  if (plan) validatePluginPlan(plan, projectRealpath, record.session_id);
  const names = fs.readdirSync(dir).filter((name) =>
    name.startsWith("initial-") || name.startsWith("delivery-"));
  if (names.length && (!plan || !Number.isSafeInteger(record.binding_generation)))
    throw new Error("PLUGIN_BINDING_MISMATCH");
  const current = names.length ? readDeliveryRecords(dir, record, plan, digest) : [];
  const archives = fs.readdirSync(dir).filter((name) => name.startsWith("prior-"));
  if (record.prior_archive === undefined) {
    if (archives.length || (depth > 0 && record.initial_status !== "accepted"))
      throw new Error("PLUGIN_LINEAGE_HEADER_INVALID");
    return current;
  }
  const continued = record.inherited_cursor_generation !== undefined;
  if (depth === 32 || archives.length !== 1 || archives[0] !== record.prior_archive ||
      !["rebound_paused", "active", "paused", "needs_reconcile"].includes(record.phase) ||
      (record.phase === "rebound_paused" && continued) ||
      (record.phase !== "rebound_paused" && !continued) ||
      (!continued && names.length) ||
      (continued && (!Number.isSafeInteger(record.inherited_cursor_generation) ||
        record.inherited_cursor_generation < 0 ||
        !["ralph", "lisa"].includes(record.inherited_cursor_turn) ||
        !/^[0-9a-f]{64}$/.test(record.continuation_evidence_sha256 ?? ""))) ||
      !UUID.test(record.prior_lease_id ?? "") ||
      !UUID.test(record.prior_recovery_id ?? "") ||
      record.prior_lease_id === record.lease_id ||
      record.prior_archive !== `prior-${record.prior_lease_id}` ||
      record.replay !== "not_replayed" ||
      record.initial_status !== "inherited_accepted")
    throw new Error("PLUGIN_LINEAGE_HEADER_INVALID");
  const archive = path.join(dir, record.prior_archive);
  try {
    const stat = fs.lstatSync(archive);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("invalid archive");
  } catch { throw new Error("PLUGIN_LINEAGE_INVALID"); }
  const prior = regularJson(path.join(archive, "record.json"), "PLUGIN_LINEAGE_INVALID");
  if (!recoverableCoordinatorPhase(prior, record.expected_digest,
      continued ? record.inherited_cursor_generation : record.cursor_generation,
      continued ? record.inherited_cursor_receipt_id : record.cursor_receipt_id,
      continued ? record.inherited_cursor_turn : record.cursor_turn) ||
      prior.project_realpath !== projectRealpath ||
      prior.session_id !== record.session_id ||
      prior.lease_id !== record.prior_lease_id || !UUID.test(prior.owner_id ?? "") ||
      prior.initial_status !== (prior.prior_archive ? "inherited_accepted" : "accepted") ||
      prior.cursor_generation !== (continued ? record.inherited_cursor_generation : record.cursor_generation) ||
      prior.cursor_receipt_id !== (continued ? record.inherited_cursor_receipt_id : record.cursor_receipt_id) ||
      prior.cursor_turn !== (continued ? record.inherited_cursor_turn : record.cursor_turn))
    throw new Error("PLUGIN_LINEAGE_RECORD_INVALID");
  digest.update(record.prior_archive).update(JSON.stringify(prior));
  return [...readLineageDeliveries(archive, prior, projectRealpath, digest, depth + 1),
    ...current].sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
}

function recoveryPluginState(projectRealpath, cliEvidence) {
  const root = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error("PLUGIN_STATE_DIR_REQUIRED");
  const key = crypto.createHash("sha256").update(projectRealpath).digest("hex");
  const dir = path.join(root, "sessions", key);
  if (!fs.existsSync(dir)) return { record: null, deliveries: [], warning: "PLUGIN_RECORD_MISSING",
    evidence_sha256: null };
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("PLUGIN_RECORD_INVALID");
  if (entryExists(path.join(dir, "rebind.pending.json")))
    throw new Error("REBIND_PENDING_REVIEW");
  if (entryExists(path.join(dir, "continuation.pending.json")))
    throw new Error("CONTINUATION_PENDING_REVIEW");
  const recordPath = path.join(dir, "record.json");
  if (!fs.existsSync(recordPath))
    return { record: null, deliveries: [], warning: "PLUGIN_RECORD_MISSING",
      evidence_sha256: null };
  const record = regularJson(recordPath);
  const digest = crypto.createHash("sha256").update(JSON.stringify(record));
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
  const deliveries = readLineageDeliveries(dir, record, projectRealpath, digest);
  const inherited = record.prior_archive !== undefined;
  return { record: { phase: record.phase, pid: record.pid,
    session_id: record.session_id, owner_id: record.owner_id,
    lease_id: record.lease_id, binding_generation: record.binding_generation ?? null,
    cursor_generation: record.cursor_generation ?? null,
    cursor_receipt_id: record.cursor_receipt_id ?? null,
    cursor_turn: record.cursor_turn ?? null,
    initial_status: record.initial_status ?? null,
    prior_lease_id: record.prior_lease_id ?? null,
    prior_recovery_id: record.prior_recovery_id ?? null,
    error: record.error ?? null }, deliveries, inherited,
    warning: deliveries.some((item) => item.status === "intent") ?
      "DELIVERY_OUTCOME_UNCERTAIN" : null,
    evidence_sha256: digest.digest("hex") };
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
    const recordedFingerprint = recordPlan.seats[role]?.native_session_fingerprint_sha256;
    seats[role] = { observation: result.code !== 0 || !agent ? "unavailable" :
      agent.name === role && agent.agent === kind &&
      agent.workspace_id === recordPlan.workspace_id &&
      agent.pane_id === recordPlan.seats[role]?.pane_id && cwd === projectRealpath ?
        (recordPlan.seats[role]?.terminal_id &&
          agent.terminal_id !== recordPlan.seats[role].terminal_id ?
            "terminal_changed" : "matches_binding") :
        "identity_changed",
      status: agent?.agent_status ?? null,
      interactive_ready: agent?.interactive_ready === true,
      pane_id: agent?.pane_id ?? null,
      terminal_id: agent?.terminal_id ?? null,
      native_session: { ...nativeSession,
        continuity: recordedFingerprint ?
          nativeSession.fingerprint_sha256 === recordedFingerprint ?
            "matches_record" : "changed_or_missing" : "not_recorded" } };
  }
  return seats;
}

function coordinatorProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unknown";
  try { process.kill(pid, 0); return "pid_exists"; }
  catch (error) {
    if (error.code === "ESRCH") return "pid_absent";
    if (error.code === "EPERM") return "pid_exists";
    return "unknown";
  }
}

function pendingPluginControl(dir) {
  for (const name of ["stop.json", "control.json"]) {
    try { fs.lstatSync(path.join(dir, name)); return true; }
    catch (error) { if (error.code !== "ENOENT") return true; }
  }
  return false;
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
    const processObservation = coordinatorProcess(plugin.record?.pid);
    const blockers = [];
    if (processObservation !== "pid_absent")
      blockers.push(processObservation === "pid_exists" ?
        "COORDINATOR_PID_PRESENT" : "COORDINATOR_PID_UNKNOWN");
    if (!plugin.record) blockers.push("PLUGIN_RECORD_MISSING");
    else {
      if ((plugin.record.initial_status !== "accepted" &&
          !(plugin.inherited && plugin.record.initial_status === "inherited_accepted")) ||
          plugin.deliveries.some((item) => item.status !== "accepted"))
        blockers.push("DELIVERY_OUTCOME_UNCERTAIN");
      const initial = plugin.deliveries.find((item) =>
        item.kind === "initial" && item.id === evidence.session_id &&
        item.status === "accepted");
      const handoffs = plugin.deliveries.filter((item) => item.kind === "handoff");
      const generations = new Set(handoffs.map((item) => item.generation));
      if (!initial || handoffs.length !== snapshot.generation ||
          generations.size !== handoffs.length ||
          handoffs.some((item) => item.generation > snapshot.generation) ||
          (snapshot.generation > 0 && !handoffs.some((item) =>
            item.id === snapshot.last_receipt_id && item.generation === snapshot.generation &&
            item.status === "accepted")))
        blockers.push("DELIVERY_RECORD_MISSING");
      if (plugin.record.cursor_generation !== snapshot.generation ||
          plugin.record.cursor_receipt_id !== snapshot.last_receipt_id ||
          plugin.record.cursor_turn !== snapshot.turn)
        blockers.push("CURSOR_STATE_MISMATCH");
      if (pendingPluginControl(path.dirname(recordPath))) blockers.push("CONTROL_PENDING");
    }
    if (!seats || Object.values(seats).some((seat) =>
      seat.observation !== "matches_binding" ||
      seat.native_session.continuity !== "matches_record"))
      blockers.push("SEAT_REBIND_REQUIRED");
    const finalCheck = invoke(diagnosis.cli, ["host", "recovery-check", "--project",
      evidence.project_realpath, "--json"]);
    const finalEvidence = readJson(finalCheck);
    if (finalCheck.code !== 0 || finalEvidence?.status !== "review_required" ||
        finalEvidence.evidence_sha256 !== evidence.evidence_sha256)
      throw new Error("RECOVERY_STATE_CHANGED");
    const finalPlugin = recoveryPluginState(evidence.project_realpath, finalEvidence);
    if (finalPlugin.evidence_sha256 !== plugin.evidence_sha256 ||
        finalPlugin.warning !== plugin.warning)
      throw new Error("RECOVERY_STATE_CHANGED");
    emit({ status: "review_required", project: evidence.project_realpath,
      cli: evidence, plugin: plugin.record, deliveries: plugin.deliveries,
      plugin_warning: plugin.warning,
      coordinator_process: processObservation, continuation_blockers: blockers,
      seats,
      restart_observation: !seats ? "binding_plan_unavailable" :
        Object.values(seats).every((seat) => seat.observation === "matches_binding" &&
          seat.native_session.continuity === "matches_record") ?
          "recorded_native_sessions_match" : "manual_rebind_required",
      note: "Matching native session fingerprints do not prove coordinator or Agents stopped. Review unrecorded deliveries before recover-lease; this action never resumes the coordinator." });
  } catch (error) {
    emit({ status: "needs_reconcile", code: error.message || "PLUGIN_RECOVERY_INVALID",
      project: evidence.project_realpath, cli: evidence }, 7);
  }
}

function rebindAudit(diagnosis, project) {
  const observed = invoke(diagnosis.cli, ["host", "snapshot", "--project", project, "--json"]);
  const snapshot = readJson(observed);
  if (observed.code !== 0 || snapshot?.status !== "ok") {
    emit({ status: "not_ready", code: snapshot?.code || "RLL_SNAPSHOT_FAILED", project }, 4);
    return;
  }
  try {
    if (snapshot.host_state !== "unclaimed" || snapshot.binding_state !== "stale" ||
        !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0)
      throw new Error("RECOVERED_LEASE_REQUIRED");
    if (!process.env.HERDR_PLUGIN_STATE_DIR ||
        !path.isAbsolute(process.env.HERDR_PLUGIN_STATE_DIR))
      throw new Error("PLUGIN_STATE_DIR_REQUIRED");
    const key = crypto.createHash("sha256").update(snapshot.project_realpath).digest("hex");
    const dir = path.join(process.env.HERDR_PLUGIN_STATE_DIR, "sessions", key);
    if (entryExists(path.join(dir, "rebind.pending.json")))
      throw new Error("REBIND_PENDING_REVIEW");
    const old = regularJson(path.join(dir, "record.json"));
    if (old.project_realpath !== snapshot.project_realpath ||
        old.session_id !== snapshot.session_id || !UUID.test(old.lease_id ?? "") ||
        !UUID.test(old.owner_id ?? "") ||
        !recoverableCoordinatorPhase(old, snapshot.state_digest,
          snapshot.generation, snapshot.last_receipt_id, snapshot.turn))
      throw new Error("PLUGIN_RECORD_INVALID");
    const oldEvidence = { session_id: old.session_id, lease_id: old.lease_id,
      owner_id: old.owner_id, binding_generation: old.binding_generation };
    const plugin = recoveryPluginState(snapshot.project_realpath, oldEvidence);
    const host = path.join(snapshot.state_realpath, "host");
    const binding = regularJson(path.join(host, "binding.json"), "RECOVERY_PROOF_INVALID");
    if (binding.lease_id !== old.lease_id ||
        binding.binding_generation !== old.binding_generation ||
        binding.workspace_id !== old.plan?.workspace_id ||
        binding.seats?.ralph?.pane_id !== old.plan?.seats?.ralph?.pane_id ||
        binding.seats?.lisa?.pane_id !== old.plan?.seats?.lisa?.pane_id)
      throw new Error("RECOVERY_PROOF_INVALID");
    const archiveDir = path.join(host, "retired-leases", old.lease_id);
    regularDirectory(path.join(host, "retired-leases"), "RECOVERY_PROOF_INVALID");
    regularDirectory(archiveDir, "RECOVERY_PROOF_INVALID");
    const archived = regularJson(path.join(archiveDir, "record.json"),
      "RECOVERY_PROOF_INVALID");
    if (archived.status !== "claimed" || archived.host !== "herdr" ||
        archived.lease_id !== old.lease_id || archived.owner_id !== old.owner_id ||
        archived.session_id !== snapshot.session_id ||
        archived.project_realpath !== snapshot.project_realpath ||
        archived.state_realpath !== snapshot.state_realpath)
      throw new Error("RECOVERY_PROOF_INVALID");
    const recoveryDir = path.join(host, "recoveries");
    regularDirectory(recoveryDir, "RECOVERY_PROOF_INVALID");
    const receipts = fs.readdirSync(recoveryDir).filter((name) => UUID.test(name.slice(0, -5)) &&
      name.endsWith(".json")).map((name) => ({ name, value: regularJson(path.join(recoveryDir, name),
      "RECOVERY_PROOF_INVALID") })).filter((item) => item.value.lease_id === old.lease_id);
    const recovery = receipts.length === 1 ? receipts[0].value : null;
    if (recovery?.status !== "recovered" || recovery.replay !== "not_replayed" ||
        recovery.decision !== "verified-stopped-no-replay" ||
        recovery.owner_id !== old.owner_id || recovery.session_id !== snapshot.session_id ||
        recovery.state_digest !== snapshot.state_digest ||
        recovery.generation !== snapshot.generation ||
        recovery.binding_generation !== old.binding_generation ||
        recovery.candidate_count !== snapshot.candidate_count ||
        receipts[0].name !== `${recovery.recovery_id}.json` ||
        recovery.last_heartbeat_seq !== archived.heartbeat_seq ||
        recovery.last_heartbeat_at !== archived.heartbeat_at ||
        !/^[0-9a-f]{64}$/.test(recovery.evidence_sha256 ?? ""))
      throw new Error("RECOVERY_PROOF_INVALID");
    const preflight = invoke([process.execPath, path.join(pluginRoot, "actions.mjs")],
      ["seat-preflight"]);
    const proposed = readJson(preflight);
    const plan = preflight.code === 0 && proposed?.status === "ready" ?
      proposed.binding_plan : null;
    const blockers = [];
    const processObservation = coordinatorProcess(old.pid);
    if (processObservation !== "pid_absent")
      blockers.push(processObservation === "pid_exists" ?
        "COORDINATOR_PID_PRESENT" : "COORDINATOR_PID_UNKNOWN");
    if (pendingPluginControl(dir)) blockers.push("CONTROL_PENDING");
    if ((old.initial_status !== "accepted" &&
        !(plugin.inherited && old.initial_status === "inherited_accepted")) ||
        plugin.deliveries.some((item) => item.status !== "accepted"))
      blockers.push("DELIVERY_OUTCOME_UNCERTAIN");
    const initial = plugin.deliveries.find((item) => item.kind === "initial" &&
      item.id === snapshot.session_id && item.status === "accepted");
    const handoffs = plugin.deliveries.filter((item) => item.kind === "handoff");
    const generations = new Set(handoffs.map((item) => item.generation));
    if (!initial || handoffs.length !== snapshot.generation ||
        generations.size !== handoffs.length ||
        handoffs.some((item) => item.generation > snapshot.generation) ||
        (snapshot.generation > 0 && !handoffs.some((item) =>
          item.id === snapshot.last_receipt_id && item.generation === snapshot.generation &&
          item.status === "accepted")))
      blockers.push("DELIVERY_RECORD_MISSING");
    if (old.cursor_generation !== snapshot.generation ||
        old.cursor_receipt_id !== snapshot.last_receipt_id ||
        old.cursor_turn !== snapshot.turn)
      blockers.push("CURSOR_STATE_MISMATCH");
    if (!plan || plan.project_realpath !== snapshot.project_realpath ||
        plan.session_id !== snapshot.session_id || plan.expected_digest !== snapshot.state_digest)
      blockers.push(proposed?.code || "SEAT_PREFLIGHT_FAILED");
    else for (const role of ["ralph", "lisa"]) {
      const fingerprint = old.plan?.seats?.[role]?.native_session_fingerprint_sha256;
      const everPrompted = role === "ralph" || handoffs.some((item) => item.role === role);
      if (everPrompted && (!fingerprint ||
          plan.seats[role]?.native_session_fingerprint_sha256 !== fingerprint))
        blockers.push(`AGENT_SESSION_UNVERIFIED_${role.toUpperCase()}`);
    }
    const reread = invoke(diagnosis.cli, ["host", "snapshot", "--project",
      snapshot.project_realpath, "--json"]);
    const finalSnapshot = readJson(reread);
    const finalPlugin = recoveryPluginState(snapshot.project_realpath, oldEvidence);
    const finalRecovery = regularJson(path.join(recoveryDir, receipts[0].name),
      "RECOVERY_PROOF_INVALID");
    const finalArchive = regularJson(path.join(archiveDir, "record.json"),
      "RECOVERY_PROOF_INVALID");
    const finalBinding = regularJson(path.join(host, "binding.json"),
      "RECOVERY_PROOF_INVALID");
    if (reread.code !== 0 || finalSnapshot?.status !== "ok" ||
        finalSnapshot.host_state !== "unclaimed" ||
        finalSnapshot.session_id !== snapshot.session_id ||
        finalSnapshot.binding_generation !== snapshot.binding_generation ||
        finalSnapshot.generation !== snapshot.generation ||
        finalSnapshot.last_receipt_id !== snapshot.last_receipt_id ||
        finalSnapshot.state_digest !== snapshot.state_digest ||
        finalSnapshot.candidate_count !== snapshot.candidate_count ||
        finalPlugin.evidence_sha256 !== plugin.evidence_sha256 ||
        JSON.stringify(finalRecovery) !== JSON.stringify(recovery) ||
        JSON.stringify(finalArchive) !== JSON.stringify(archived) ||
        JSON.stringify(finalBinding) !== JSON.stringify(binding))
      throw new Error("RECOVERY_STATE_CHANGED");
    const evidenceSha = crypto.createHash("sha256").update(JSON.stringify({
      session_id: snapshot.session_id, state_digest: snapshot.state_digest,
      generation: snapshot.generation, last_receipt_id: snapshot.last_receipt_id,
      old_lease_id: old.lease_id, old_phase: old.phase,
      recovery_id: recovery.recovery_id,
      plugin_digest: plugin.evidence_sha256, plan,
    })).digest("hex");
    emit({ status: blockers.length ? "not_ready" : "review_required",
      code: blockers.length ? "REBIND_BLOCKED" : null,
      project: snapshot.project_realpath, session_id: snapshot.session_id,
      old_lease_id: old.lease_id, old_phase: old.phase,
      recovery_id: recovery.recovery_id,
      generation: snapshot.generation, last_receipt_id: snapshot.last_receipt_id,
      turn: snapshot.turn, coordinator_process: processObservation,
      continuation_blockers: blockers, binding_plan: plan,
      plugin_evidence_sha256: plugin.evidence_sha256,
      evidence_sha256: evidenceSha,
      note: "Read-only rebind preflight. Human confirmation and a separate guarded rebind action are still required; this never claims a lease or prompts an Agent." },
    blockers.length ? 4 : 0);
  } catch (error) {
    emit({ status: "needs_reconcile", code: error.message || "REBIND_CHECK_FAILED",
      project: snapshot.project_realpath }, 7);
  }
}

function continuationAudit(diagnosis, project) {
  const readSnapshot = () => {
    const result = invoke(diagnosis.cli, ["host", "snapshot", "--project", project, "--json"]);
    const value = readJson(result);
    if (result.code !== 0 || value?.status !== "ok")
      throw new Error(value?.code || "RLL_SNAPSHOT_FAILED");
    return value;
  };
  try {
    const snapshot = readSnapshot();
    if (snapshot.host_state !== "claimed" || snapshot.binding_state !== "bound")
      throw new Error("REBOUND_LEASE_REQUIRED");
    const root = process.env.HERDR_PLUGIN_STATE_DIR;
    if (!root || !path.isAbsolute(root)) throw new Error("PLUGIN_STATE_DIR_REQUIRED");
    const key = crypto.createHash("sha256").update(snapshot.project_realpath).digest("hex");
    const dir = path.join(root, "sessions", key);
    if (entryExists(path.join(dir, "rebind.pending.json")))
      throw new Error("REBIND_PENDING_REVIEW");
    if (entryExists(path.join(dir, "continuation.pending.json")))
      throw new Error("CONTINUATION_PENDING_REVIEW");
    if (pendingPluginControl(dir)) throw new Error("CONTROL_PENDING");
    const record = regularJson(path.join(dir, "record.json"));
    const leaseFile = path.join(snapshot.state_realpath, "host", "lease", "record.json");
    const lease = regularJson(leaseFile, "CONTINUATION_LEASE_INVALID");
    if (lease.status !== "claimed" || lease.host !== "herdr" ||
        lease.project_realpath !== snapshot.project_realpath ||
        lease.state_realpath !== snapshot.state_realpath ||
        lease.session_id !== snapshot.session_id ||
        lease.owner_id !== snapshot.owner_id || lease.owner_id !== record.owner_id ||
        lease.lease_id !== record.lease_id || !UUID.test(lease.lease_id ?? ""))
      throw new Error("CONTINUATION_LEASE_MISMATCH");
    const plugin = recoveryPluginState(snapshot.project_realpath, {
      ...snapshot, lease_id: lease.lease_id,
    });
    if (record.phase !== "rebound_paused" || !plugin.inherited ||
        record.pause_state_digest !== snapshot.state_digest ||
        record.cursor_generation !== snapshot.generation ||
        record.cursor_receipt_id !== snapshot.last_receipt_id ||
        record.cursor_turn !== snapshot.turn ||
        record.pause_generation !== snapshot.generation ||
        record.pause_receipt_id !== snapshot.last_receipt_id ||
        record.pause_turn !== snapshot.turn ||
        snapshot.workspace_id !== record.plan.workspace_id ||
        snapshot.seats?.ralph?.pane_id !== record.plan.seats.ralph.pane_id ||
        snapshot.seats?.lisa?.pane_id !== record.plan.seats.lisa.pane_id)
      throw new Error("CONTINUATION_CURSOR_MISMATCH");
    const blockers = [];
    if (plugin.warning || plugin.deliveries.some((item) => item.status !== "accepted"))
      blockers.push("DELIVERY_OUTCOME_UNCERTAIN");
    const initial = plugin.deliveries.find((item) => item.kind === "initial" &&
      item.id === snapshot.session_id && item.status === "accepted");
    const handoffs = plugin.deliveries.filter((item) => item.kind === "handoff");
    const generations = new Set(handoffs.map((item) => item.generation));
    if (!initial || handoffs.length !== snapshot.generation ||
        generations.size !== handoffs.length ||
        handoffs.some((item) => item.generation < 1 || item.generation > snapshot.generation) ||
        (snapshot.generation > 0 && !handoffs.some((item) =>
          item.id === snapshot.last_receipt_id && item.generation === snapshot.generation &&
          item.status === "accepted")))
      blockers.push("DELIVERY_RECORD_MISSING");
    const seats = recoverySeats(diagnosis.herdr, snapshot.project_realpath, record.plan);
    for (const role of ["ralph", "lisa"]) {
      const seat = seats?.[role];
      const prompted = role === "ralph" || handoffs.some((item) => item.role === role);
      if (!seat || seat.observation !== "matches_binding" ||
          !seat.interactive_ready || !["idle", "done"].includes(seat.status) ||
          (prompted && seat.native_session.continuity !== "matches_record"))
        blockers.push(`SEAT_NOT_READY_${role.toUpperCase()}`);
    }
    const finalSnapshot = readSnapshot();
    const finalLease = regularJson(leaseFile, "CONTINUATION_LEASE_INVALID");
    const finalPlugin = recoveryPluginState(snapshot.project_realpath, {
      ...finalSnapshot, lease_id: finalLease.lease_id,
    });
    if (JSON.stringify(finalSnapshot) !== JSON.stringify(snapshot) ||
        JSON.stringify(finalLease) !== JSON.stringify(lease) ||
        finalPlugin.evidence_sha256 !== plugin.evidence_sha256)
      throw new Error("CONTINUATION_STATE_CHANGED");
    const evidence = crypto.createHash("sha256").update(JSON.stringify({
      snapshot, lease, plugin_sha256: plugin.evidence_sha256, seats,
    })).digest("hex");
    emit({ status: blockers.length ? "not_ready" : "review_required",
      code: blockers.length ? "CONTINUATION_BLOCKED" : null,
      project: snapshot.project_realpath, session_id: snapshot.session_id,
      lease_id: lease.lease_id, generation: snapshot.generation,
      last_receipt_id: snapshot.last_receipt_id, turn: snapshot.turn,
      binding_generation: snapshot.binding_generation,
      continuation_blockers: blockers, seats, evidence_sha256: evidence,
      note: "Read-only continuation preflight. It does not start heartbeats or deliver prompts." },
    blockers.length ? 4 : 0);
  } catch (error) {
    emit({ status: "needs_reconcile", code: error.message || "CONTINUATION_CHECK_FAILED",
      project }, 7);
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
        typeof agent.pane_id !== "string" || !agent.pane_id ||
        typeof agent.terminal_id !== "string" || !agent.terminal_id) {
      return { status: "not_ready", code: "AGENT_IDENTITY_MISMATCH", role };
    }
    let agentCwd = null;
    try { agentCwd = fs.realpathSync.native(agent.cwd); } catch { /* Treat as mismatch. */ }
    if (agentCwd !== snapshot.project_realpath)
      return { status: "not_ready", code: "AGENT_PROJECT_MISMATCH", role };
    if (!agent.interactive_ready || !["idle", "done"].includes(agent.agent_status))
      return { status: "not_ready", code: "AGENT_NOT_READY", role };
    const nativeSession = nativeSessionReference(agent, kind);
    if (nativeSession.status === "invalid")
      return { status: "not_ready", code: "AGENT_SESSION_INVALID", role };
    seats[role] = { pane_id: agent.pane_id, terminal_id: agent.terminal_id,
      agent_target: role, agent_kind: kind,
      native_session_fingerprint_sha256: nativeSession.fingerprint_sha256 };
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
  if (action === "rebind-check") {
    rebindAudit(diagnosis, project);
    return;
  }
  if (action === "continuation-check") {
    continuationAudit(diagnosis, project);
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
