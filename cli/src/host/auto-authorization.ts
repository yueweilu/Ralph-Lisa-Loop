/** A session-scoped operator grant. It does not verify who authored a candidate. */
import * as fs from "node:fs";
import * as path from "node:path";
import { readLaunchIntent } from "../herdr/launch-record.js";
import { readBinding } from "./binding.js";
import { readGeneration } from "./generation.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, entryExists, readLease } from "./lease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE = "auto-authorization.json";

export interface AutoAuthorization {
  schema: 1;
  status: "active";
  mode: "unattended_candidate_commit";
  policy_revision: 1;
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  launch_request_id: string;
  lease_id: string;
  binding_generation: number;
  workspace_id: string;
  seats: {
    ralph: { pane_id: string; agent_target: string };
    lisa: { pane_id: string; agent_target: string };
  };
  task_sha256: string;
  permission_profile: "interactive" | "full_auto";
  granted_via: "cli_auto_host_herdr" | "plugin_start_task";
  source_verification: "unverified";
  granted_at: string;
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Missing means manual mode; malformed or incomplete evidence fails closed. */
export function readAutoAuthorization(host: string, project: string, state: string,
  sessionId: string): AutoAuthorization | null {
  const file = path.join(host, FILE);
  if (!entryExists(file)) {
    if (entryExists(path.join(host, "auto-authorization.pending")))
      throw new HostContractError("NEEDS_RECONCILE", 7, "Auto authorization write is incomplete");
    return null;
  }
  let value: AutoAuthorization;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid authorization file");
    value = JSON.parse(fs.readFileSync(file, "utf8")) as AutoAuthorization;
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable auto authorization");
  }
  const seats = value?.seats;
  if (!value || value.schema !== 1 || value.status !== "active" ||
      value.mode !== "unattended_candidate_commit" || value.policy_revision !== 1 ||
      value.project_realpath !== project || value.state_realpath !== state ||
      value.session_id !== sessionId || !UUID.test(value.launch_request_id ?? "") ||
      !UUID.test(value.lease_id ?? "") ||
      !Number.isSafeInteger(value.binding_generation) || value.binding_generation < 1 ||
      typeof value.workspace_id !== "string" || !value.workspace_id ||
      !seats || [seats.ralph, seats.lisa].some((seat) =>
        !seat || typeof seat.pane_id !== "string" || !seat.pane_id ||
        typeof seat.agent_target !== "string" || !seat.agent_target) ||
      seats.ralph.pane_id === seats.lisa.pane_id ||
      seats.ralph.agent_target === seats.lisa.agent_target ||
      !SHA256.test(value.task_sha256 ?? "") ||
      !["interactive", "full_auto"].includes(value.permission_profile) ||
      !["cli_auto_host_herdr", "plugin_start_task"].includes(value.granted_via) ||
      value.source_verification !== "unverified" ||
      typeof value.granted_at !== "string" || !Number.isFinite(Date.parse(value.granted_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid auto authorization");
  }
  let launch;
  try { launch = readLaunchIntent(project, value.launch_request_id); }
  catch { throw new HostContractError("NEEDS_RECONCILE", 7, "Auto authorization launch intent is invalid"); }
  if (launch.auto_commit !== true || launch.session_id !== sessionId ||
      launch.task_sha256 !== value.task_sha256 ||
      launch.permission_profile !== value.permission_profile) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Auto authorization differs from launch intent");
  }
  if (entryExists(path.join(host, "auto-authorization.pending")))
    throw new HostContractError("NEEDS_RECONCILE", 7, "Auto authorization write is incomplete");
  return value;
}

/** Requires a fresh Herdr launch intent and a fully bound generation-zero lease. */
export function grantAutoAuthorization(project: string, leaseId: string, launchRequestId: string,
  expectedBindingGeneration: number, grantedVia: AutoAuthorization["granted_via"]): AutoAuthorization {
  if (!UUID.test(leaseId) || !UUID.test(launchRequestId) ||
      !Number.isSafeInteger(expectedBindingGeneration) || expectedBindingGeneration < 1 ||
      !["cli_auto_host_herdr", "plugin_start_task"].includes(grantedVia))
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid auto authorization identifiers");
  const root = canonicalProject(project);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id ||
      initial.contract_state !== "identified")
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for auto authorization");
  const release = acquireHostLock(initial.state_realpath);
  try {
    const current = inspectProject(root);
    if (current.state_realpath !== initial.state_realpath || current.session_id !== initial.session_id)
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    const host = path.join(initial.state_realpath, "host");
    const existing = readAutoAuthorization(host, root, initial.state_realpath, initial.session_id);
    if (existing) {
      if (existing.lease_id !== leaseId.toLowerCase() ||
          existing.launch_request_id !== launchRequestId.toLowerCase() ||
          existing.binding_generation !== expectedBindingGeneration ||
          existing.granted_via !== grantedVia)
        throw new HostContractError("DUPLICATE_CONFLICT", 5, "Auto authorization belongs to another launch or lease");
      return existing;
    }
    let launch;
    try { launch = readLaunchIntent(root, launchRequestId.toLowerCase()); }
    catch { throw new HostContractError("AUTO_AUTHORIZATION_REQUIRED", 5, "No valid auto-authorized launch intent"); }
    if (launch.auto_commit !== true)
      throw new HostContractError("AUTO_AUTHORIZATION_REQUIRED", 5, "Launch did not grant automatic candidate commits");
    const lease = readLease(host);
    const binding = readBinding(host);
    const generation = readGeneration(host, root, initial.state_realpath, initial.session_id);
    if (lease.lease_id !== leaseId.toLowerCase() || lease.host !== "herdr" ||
        lease.project_realpath !== root || lease.session_id !== initial.session_id ||
        !binding || binding.lease_id !== lease.lease_id ||
        binding.binding_generation !== expectedBindingGeneration ||
        !binding.seats.ralph || !binding.seats.lisa ||
        !generation || generation.generation !== 0 || generation.last_receipt_id !== null ||
        generation.turn !== "ralph")
      throw new HostContractError("AUTO_AUTHORIZATION_NOT_READY", 5, "Auto authorization requires the bound initial turn");
    const record: AutoAuthorization = {
      schema: 1, status: "active", mode: "unattended_candidate_commit", policy_revision: 1,
      project_realpath: root, state_realpath: initial.state_realpath,
      session_id: initial.session_id, launch_request_id: launchRequestId.toLowerCase(),
      lease_id: lease.lease_id, binding_generation: binding.binding_generation,
      workspace_id: binding.workspace_id,
      seats: {
        ralph: { pane_id: binding.seats.ralph.pane_id, agent_target: binding.seats.ralph.agent_target },
        lisa: { pane_id: binding.seats.lisa.pane_id, agent_target: binding.seats.lisa.agent_target },
      },
      task_sha256: launch.task_sha256, permission_profile: launch.permission_profile,
      granted_via: grantedVia, source_verification: "unverified",
      granted_at: new Date().toISOString(),
    };
    const pending = path.join(host, "auto-authorization.pending");
    const fd = fs.openSync(pending, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(pending, path.join(host, FILE));
    syncDirectory(host);
    return record;
  } finally { release(); }
}
