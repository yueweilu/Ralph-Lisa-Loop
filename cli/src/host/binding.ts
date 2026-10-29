import * as fs from "node:fs";
import * as path from "node:path";
import { HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertNoPendingIntents, entryExists, readLease } from "./lease.js";

export interface SeatBinding {
  pane_id: string;
  agent_target: string;
  agent_session: null;
  verification: "unverified";
}

export interface HostBinding {
  schema: 1;
  status: "bound";
  host_kind: "herdr";
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease_id: string;
  workspace_id: string;
  binding_generation: number;
  seats: { ralph: SeatBinding | null; lisa: SeatBinding | null };
  updated_at: string;
}

function validOpaqueId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

function validSeat(value: unknown): value is SeatBinding | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const seat = value as Record<string, unknown>;
  return typeof seat.pane_id === "string" && validOpaqueId(seat.pane_id) &&
    typeof seat.agent_target === "string" && validOpaqueId(seat.agent_target) &&
    seat.agent_session === null && seat.verification === "unverified";
}

export function readBinding(host: string): HostBinding | null {
  const file = path.join(host, "binding.json");
  if (!entryExists(file)) return null;
  let value: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid binding file");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable host binding");
  }
  if (!value || typeof value !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host binding");
  }
  const binding = value as Record<string, unknown>;
  const seats = binding.seats as Record<string, unknown> | null;
  if (binding.schema !== 1 || binding.status !== "bound" || binding.host_kind !== "herdr" ||
      typeof binding.project_realpath !== "string" || typeof binding.state_realpath !== "string" ||
      typeof binding.session_id !== "string" || typeof binding.lease_id !== "string" ||
      typeof binding.workspace_id !== "string" || !validOpaqueId(binding.workspace_id) ||
      !Number.isSafeInteger(binding.binding_generation) || (binding.binding_generation as number) < 1 ||
      !seats || typeof seats !== "object" || !validSeat(seats.ralph) || !validSeat(seats.lisa) ||
      (seats.ralph === null && seats.lisa === null) ||
      (seats.ralph !== null && seats.lisa !== null &&
        ((seats.ralph as SeatBinding).pane_id === (seats.lisa as SeatBinding).pane_id ||
         (seats.ralph as SeatBinding).agent_target === (seats.lisa as SeatBinding).agent_target))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host binding");
  }
  return binding as unknown as HostBinding;
}

export function bindSeat(
  project: string, leaseId: string, role: string, workspaceId: string, paneId: string, agentTarget: string
): HostBinding {
  if ((role !== "ralph" && role !== "lisa") ||
      !validOpaqueId(workspaceId) || !validOpaqueId(paneId) || !validOpaqueId(agentTarget)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Role must be ralph/lisa and Herdr IDs must be nonempty opaque strings");
  }
  const initial = inspectProject(project);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id) {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified RLL session is required for seat binding");
  }
  const releaseLock = acquireHostLock(initial.state_realpath);
  try {
    const current = inspectProject(project);
    if (current.session_id !== initial.session_id || current.state_realpath !== initial.state_realpath) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    const host = path.join(current.state_realpath!, "host");
    let hostStat: fs.Stats;
    try {
      hostStat = fs.lstatSync(host);
    } catch {
      throw new HostContractError("HOST_NOT_CLAIMED", 4, "Claim the Herdr host before binding seats");
    }
    if (!hostStat.isDirectory() || hostStat.isSymbolicLink() || fs.realpathSync.native(host) !== host) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host directory");
    }
    for (const name of ["claim.lock", "reconcile.json", "lease.json", "binding.pending"]) {
      if (entryExists(path.join(host, name))) {
        throw new HostContractError("NEEDS_RECONCILE", 7, `Host marker ${name} requires reconciliation`);
      }
    }
    assertNoPendingIntents(host);
    let lease;
    try {
      lease = readLease(host);
    } catch (error) {
      if (error instanceof HostContractError) throw error;
      throw new HostContractError("HOST_NOT_CLAIMED", 4, "Claim the Herdr host before binding seats");
    }
    if (lease.lease_id !== leaseId) {
      throw new HostContractError("LEASE_MISMATCH", 4, "Lease belongs to another coordinator");
    }
    if (lease.project_realpath !== current.project_realpath || lease.state_realpath !== current.state_realpath ||
        lease.session_id !== current.session_id) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Lease belongs to another RLL session");
    }

    const previous = readBinding(host);
    if (previous && (previous.project_realpath !== current.project_realpath ||
        previous.state_realpath !== current.state_realpath || previous.session_id !== current.session_id)) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Binding belongs to another RLL session");
    }
    const currentLease = previous?.lease_id === leaseId;
    if (currentLease && previous!.workspace_id !== workspaceId) {
      throw new HostContractError("WORKSPACE_MISMATCH", 4, "Both seats must use one Herdr workspace");
    }
    const seats = currentLease
      ? { ...previous!.seats }
      : { ralph: null as SeatBinding | null, lisa: null as SeatBinding | null };
    const other = role === "ralph" ? seats.lisa : seats.ralph;
    if (other?.pane_id === paneId || other?.agent_target === agentTarget) {
      throw new HostContractError("WRONG_SEAT", 4, "Ralph and Lisa must use distinct Pane and Agent targets");
    }
    const existing = role === "ralph" ? seats.ralph : seats.lisa;
    if (currentLease && existing?.pane_id === paneId && existing.agent_target === agentTarget) {
      return previous!; // A retry of the same binding must not advance its generation.
    }
    const seat: SeatBinding = {
      pane_id: paneId,
      agent_target: agentTarget,
      agent_session: null,
      verification: "unverified",
    };
    seats[role] = seat;
    const next: HostBinding = {
      schema: 1, status: "bound", host_kind: "herdr",
      project_realpath: current.project_realpath,
      state_realpath: current.state_realpath!,
      session_id: current.session_id!,
      lease_id: leaseId,
      workspace_id: workspaceId,
      binding_generation: (previous?.binding_generation ?? 0) + 1,
      seats,
      updated_at: new Date().toISOString(),
    };
    // A leftover pending file means the caller must reconcile before retrying.
    const pending = path.join(host, "binding.pending");
    const fd = fs.openSync(pending, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(next) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(pending, path.join(host, "binding.json"));
    return next;
  } finally {
    releaseLock();
  }
}
