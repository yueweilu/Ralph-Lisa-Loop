import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { generateSessionName } from "../commands.js";
import { acquireSessionCommandLock } from "./guard.js";
import { HostContractError, inspectProject } from "./inspect.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HostLease {
  schema: 1;
  status: "claimed";
  host: "herdr";
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  owner_id: string;
  lease_id: string;
  claimed_at: string;
  heartbeat_seq?: number;
  heartbeat_at?: string;
}

function requiredSession(project: string) {
  const inspection = inspectProject(project);
  if (!inspection.initialized || !inspection.state_realpath) {
    throw new HostContractError("SESSION_NOT_INITIALIZED", 3, "Initialize the RLL session before claiming a host");
  }
  if (inspection.contract_state !== "identified" || !inspection.session_id) {
    throw new HostContractError("ADOPT_REQUIRED", 3, "Legacy sessions require explicit host adopt before claim");
  }
  return inspection;
}

export function assertNoManualRuntime(project: string, state: string): void {
  for (const name of ["watcher.pid", "watcher_wrapper.pid"]) {
    const pidPath = path.join(state, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(pidPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new HostContractError("NEEDS_RECONCILE", 7, `Cannot inspect ${name}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `${name} must be a regular file`);
    }
    const pidText = fs.readFileSync(pidPath, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(pidText)) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Invalid ${name}`);
    }
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid)) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Invalid ${name}`);
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw new HostContractError("HOST_BUSY", 4, `Cannot exclude an active ${name} process`);
    }
    let args: string;
    try {
      args = execFileSync("ps", ["-p", pidText, "-o", "args="], { encoding: "utf8" }).trim();
    } catch {
      throw new HostContractError("HOST_BUSY", 4, `Cannot verify ${name} process identity`);
    }
    if (args.includes(path.join(state, "watcher.sh"))) {
      throw new HostContractError("HOST_BUSY", 4, "Stop the active tmux watcher before host claim");
    }
  }

  const tmux = spawnSync("tmux", ["has-session", "-t", generateSessionName(project)], { encoding: "utf8" });
  if (tmux.status === 0) {
    throw new HostContractError("HOST_BUSY", 4, "Stop the active RLL tmux session before host claim");
  }
  if (tmux.error && (tmux.error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new HostContractError("HOST_IO_ERROR", 8, "Cannot check the RLL tmux session");
  }
  if (!tmux.error && tmux.status !== 1) {
    throw new HostContractError("HOST_IO_ERROR", 8, "Cannot determine the RLL tmux session state");
  }
}

function hostDirectory(state: string): string {
  const dir = path.join(state, "host");
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host directory");
  }
  return dir;
}

export function entryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function assertAdoptionReady(host: string, project: string, state: string, sessionId: string): void {
  const file = path.join(host, "adoption.json");
  if (!entryExists(file)) return;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid adoption file");
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (record.schema !== 1 || record.kind !== "legacy_adoption" || record.status !== "confirmed" ||
        record.project_realpath !== project || record.state_realpath !== state || record.session_id !== sessionId) {
      throw new Error("adoption is not confirmed for this session");
    }
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Legacy adoption is incomplete or belongs to another session");
  }
}

function assertNoHostMarkers(host: string): void {
  for (const name of ["lease", "lease.json", "claim.lock", "reconcile.json", "binding.pending", "adoption.pending", "generation.pending"]) {
    if (entryExists(path.join(host, name))) {
      throw new HostContractError("HOST_BUSY", 4, "Host is already claimed or needs reconciliation");
    }
  }
  assertNoPendingIntents(host);
  assertNoPendingCandidates(host);
}

export function assertNoPendingIntents(host: string): void {
  const intentsDir = path.join(host, "intents");
  if (entryExists(intentsDir)) {
    const stat = fs.lstatSync(intentsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(intentsDir).length > 0) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Resolve pending host intents before changing the lease");
    }
  }
}

export function assertNoPendingCandidates(host: string): void {
  const candidates = path.join(host, "candidates");
  if (!entryExists(candidates)) return;
  const stat = fs.lstatSync(candidates);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(candidates) !== candidates ||
      fs.readdirSync(candidates).some((name) => !UUID.test(name))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Incomplete or invalid candidate inbox");
  }
}

export function acquireHostLock(state: string): () => void {
  try {
    return acquireSessionCommandLock(state);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("HOST_BUSY:")) {
      throw new HostContractError("HOST_BUSY", 4, error.message);
    }
    throw error;
  }
}

export function readLease(host: string): HostLease {
  const leaseDir = path.join(host, "lease");
  const stat = fs.lstatSync(leaseDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid lease directory");
  }
  if (entryExists(path.join(leaseDir, "record.pending"))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Interrupted lease heartbeat requires reconciliation");
  }
  const recordPath = path.join(leaseDir, "record.json");
  const recordStat = fs.lstatSync(recordPath);
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid lease record");
  }
  let record: HostLease;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as HostLease;
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable lease record");
  }
  if (record.schema !== 1 || record.status !== "claimed" || record.host !== "herdr" ||
      !UUID.test(record.lease_id) || !UUID.test(record.owner_id) ||
      ((record.heartbeat_seq === undefined) !== (record.heartbeat_at === undefined)) ||
      (record.heartbeat_seq !== undefined &&
        (!Number.isSafeInteger(record.heartbeat_seq) || record.heartbeat_seq < 0 ||
         typeof record.heartbeat_at !== "string" || !Number.isFinite(Date.parse(record.heartbeat_at))))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid lease record");
  }
  return record;
}

export function claimHost(project: string, host: string, ownerId: string): HostLease {
  if (host !== "herdr" || !UUID.test(ownerId)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--host must be herdr and --owner-id must be a UUID");
  }
  const initial = requiredSession(project);
  const releaseLock = acquireHostLock(initial.state_realpath!);
  try {
    const current = requiredSession(project);
    if (current.session_id !== initial.session_id || current.state_realpath !== initial.state_realpath) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    const hostDir = hostDirectory(current.state_realpath!);
    assertNoHostMarkers(hostDir);
    assertAdoptionReady(hostDir, current.project_realpath, current.state_realpath!, current.session_id!);
    assertNoManualRuntime(current.project_realpath, current.state_realpath!);

    // The directory is the durable atomic reservation. A crash leaves it in place.
    const leaseDir = path.join(hostDir, "lease");
    try {
      fs.mkdirSync(leaseDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new HostContractError("HOST_BUSY", 4, "Host lease was claimed concurrently");
      }
      throw error;
    }
    const claimedAt = new Date().toISOString();
    const record: HostLease = {
      schema: 1, status: "claimed", host: "herdr",
      project_realpath: current.project_realpath,
      state_realpath: current.state_realpath!,
      session_id: current.session_id!,
      owner_id: ownerId,
      lease_id: crypto.randomUUID(),
      claimed_at: claimedAt,
      heartbeat_seq: 0,
      heartbeat_at: claimedAt,
    };
    const fd = fs.openSync(path.join(leaseDir, "record.json"), "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  } finally {
    releaseLock();
  }
}

/** A heartbeat records the current owner; it never expires or steals a lease. */
export function heartbeatHost(project: string, leaseId: string, ownerId: string): HostLease {
  if (!UUID.test(leaseId) || !UUID.test(ownerId)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--lease-id and --owner-id must be UUIDs");
  }
  const initial = requiredSession(project);
  const releaseLock = acquireHostLock(initial.state_realpath!);
  try {
    const current = requiredSession(project);
    if (current.session_id !== initial.session_id || current.state_realpath !== initial.state_realpath) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    const hostDir = hostDirectory(current.state_realpath!);
    assertAdoptionReady(hostDir, current.project_realpath, current.state_realpath!, current.session_id!);
    if (["reconcile.json", "claim.lock", "lease.json", "binding.pending", "adoption.pending", "generation.pending"].some((name) => entryExists(path.join(hostDir, name)))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Resolve pending host state before heartbeat");
    }
    assertNoPendingIntents(hostDir);
    assertNoPendingCandidates(hostDir);
    let record: HostLease;
    try {
      record = readLease(hostDir);
    } catch (error) {
      if (error instanceof HostContractError) throw error;
      throw new HostContractError("HOST_NOT_CLAIMED", 4, "Claim the Herdr host before heartbeat");
    }
    if (record.lease_id !== leaseId || record.owner_id !== ownerId) {
      throw new HostContractError("LEASE_MISMATCH", 4, "Lease belongs to another coordinator");
    }
    if (record.project_realpath !== current.project_realpath || record.state_realpath !== current.state_realpath ||
        record.session_id !== current.session_id) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Lease belongs to another RLL session");
    }
    assertNoManualRuntime(current.project_realpath, current.state_realpath!);
    const sequence = record.heartbeat_seq ?? 0;
    if (sequence === Number.MAX_SAFE_INTEGER) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Lease heartbeat sequence exhausted");
    }
    const previousTime = Date.parse(record.heartbeat_at ?? record.claimed_at);
    const next: HostLease = {
      ...record,
      heartbeat_seq: sequence + 1,
      heartbeat_at: new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString(),
    };
    const pending = path.join(hostDir, "lease", "record.pending");
    const fd = fs.openSync(pending, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(next) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(pending, path.join(hostDir, "lease", "record.json"));
    return next;
  } finally {
    releaseLock();
  }
}

export function releaseHost(project: string, leaseId: string): { schema: 1; status: "released"; session_id: string; lease_id: string } {
  if (!UUID.test(leaseId)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--lease-id must be a UUID");
  }
  const initial = requiredSession(project);
  const releaseLock = acquireHostLock(initial.state_realpath!);
  try {
    const current = requiredSession(project);
    if (current.session_id !== initial.session_id || current.state_realpath !== initial.state_realpath) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    const hostDir = hostDirectory(current.state_realpath!);
    assertAdoptionReady(hostDir, current.project_realpath, current.state_realpath!, current.session_id!);
    if (["reconcile.json", "claim.lock", "lease.json", "binding.pending", "adoption.pending", "generation.pending"].some((name) => entryExists(path.join(hostDir, name)))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Resolve pending host state before release");
    }
    assertNoPendingIntents(hostDir);
    assertNoPendingCandidates(hostDir);
    let record: HostLease;
    try {
      record = readLease(hostDir);
    } catch (error) {
      if (error instanceof HostContractError) throw error;
      throw new HostContractError("NEEDS_RECONCILE", 7, "Lease is missing or unreadable");
    }
    if (record.lease_id !== leaseId) {
      throw new HostContractError("LEASE_MISMATCH", 4, "Lease belongs to another coordinator");
    }
    if (record.project_realpath !== current.project_realpath || record.state_realpath !== current.state_realpath || record.session_id !== current.session_id) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Lease belongs to another RLL session");
    }
    fs.unlinkSync(path.join(hostDir, "lease", "record.json"));
    fs.rmdirSync(path.join(hostDir, "lease"));
    return { schema: 1, status: "released", session_id: current.session_id!, lease_id: leaseId };
  } finally {
    releaseLock();
  }
}
