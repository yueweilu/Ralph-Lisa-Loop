import * as fs from "node:fs";
import * as path from "node:path";
import { businessDigest } from "./business.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertAdoptionReady, assertNoManualRuntime, assertNoPendingIntents, entryExists, readLease } from "./lease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface GenerationRecord {
  schema: 1;
  status: "ready";
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  generation: number;
  state_digest: string;
  turn: "ralph" | "lisa";
  round: number;
  step: string;
  last_receipt_id: string | null;
  created_at: string;
  updated_at: string;
}

export function readGeneration(host: string, project: string, state: string, sessionId: string): GenerationRecord | null {
  if (entryExists(path.join(host, "generation.pending"))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Interrupted generation update requires reconciliation");
  }
  const file = path.join(host, "generation.json");
  if (!entryExists(file)) return null;
  let value: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid generation file");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable generation record");
  }
  if (!value || typeof value !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid generation record");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || record.status !== "ready" ||
      record.project_realpath !== project || record.state_realpath !== state || record.session_id !== sessionId ||
      !Number.isSafeInteger(record.generation) || (record.generation as number) < 0 ||
      typeof record.state_digest !== "string" || !SHA256.test(record.state_digest) ||
      (record.turn !== "ralph" && record.turn !== "lisa") ||
      !Number.isSafeInteger(record.round) || (record.round as number) < 1 ||
      typeof record.step !== "string" || !record.step ||
      (record.last_receipt_id !== null && (typeof record.last_receipt_id !== "string" || !UUID.test(record.last_receipt_id))) ||
      (record.generation === 0 && record.last_receipt_id !== null) ||
      (record.generation !== 0 && record.last_receipt_id === null) ||
      typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at)) ||
      typeof record.updated_at !== "string" || !Number.isFinite(Date.parse(record.updated_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid generation record");
  }
  return record as unknown as GenerationRecord;
}

export function assertGenerationMatchesBusiness(
  record: GenerationRecord, digest: string, turn: string, round: number, step: string
): void {
  if (record.state_digest !== digest || record.turn !== turn || record.round !== round || record.step !== step) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Business state differs from the committed generation");
  }
}

/** Establish generation zero without changing the RLL business files. */
export function prepareGeneration(project: string, leaseId: string, expectedDigest: string): GenerationRecord {
  if (!UUID.test(leaseId) || !SHA256.test(expectedDigest)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--lease-id must be a UUID and --expected-digest a SHA-256");
  }
  const root = canonicalProject(project);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id) {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified RLL session is required for generation preparation");
  }
  const releaseLock = acquireHostLock(initial.state_realpath);
  try {
    const current = inspectProject(root);
    if (current.session_id !== initial.session_id || current.state_realpath !== initial.state_realpath) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    const host = path.join(current.state_realpath!, "host");
    if (!entryExists(host)) throw new HostContractError("HOST_NOT_CLAIMED", 4, "Claim the host before preparing a generation");
    const hostStat = fs.lstatSync(host);
    if (!hostStat.isDirectory() || hostStat.isSymbolicLink() || fs.realpathSync.native(host) !== host) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host directory");
    }
    assertAdoptionReady(host, current.project_realpath, current.state_realpath!, current.session_id!);
    for (const name of ["claim.lock", "reconcile.json", "lease.json", "binding.pending", "adoption.pending", "generation.pending", "receipts", "candidates"]) {
      if (entryExists(path.join(host, name))) {
        throw new HostContractError("NEEDS_RECONCILE", 7, `Host metadata ${name} requires reconciliation`);
      }
    }
    assertNoPendingIntents(host);
    let lease;
    try {
      lease = readLease(host);
    } catch (error) {
      if (error instanceof HostContractError) throw error;
      throw new HostContractError("HOST_NOT_CLAIMED", 4, "Claim the host before preparing a generation");
    }
    if (lease.lease_id !== leaseId) {
      throw new HostContractError("LEASE_MISMATCH", 4, "Lease belongs to another coordinator");
    }
    if (lease.project_realpath !== current.project_realpath || lease.state_realpath !== current.state_realpath ||
        lease.session_id !== current.session_id) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Lease belongs to another RLL session");
    }
    assertNoManualRuntime(current.project_realpath, current.state_realpath!);
    const digest = businessDigest(current.state_realpath!, current.turn!, current.round!, current.step!);
    if (digest !== expectedDigest) {
      throw new HostContractError("STALE_STATE", 5, "Business state changed since the coordinator snapshot");
    }
    const previous = readGeneration(host, current.project_realpath, current.state_realpath!, current.session_id!);
    if (previous) {
      assertGenerationMatchesBusiness(previous, digest, current.turn!, current.round!, current.step!);
      return previous;
    }
    const now = new Date().toISOString();
    const record: GenerationRecord = {
      schema: 1, status: "ready", project_realpath: current.project_realpath,
      state_realpath: current.state_realpath!, session_id: current.session_id!,
      generation: 0, state_digest: digest, turn: current.turn!, round: current.round!,
      step: current.step!, last_receipt_id: null, created_at: now, updated_at: now,
    };
    const pending = path.join(host, "generation.pending");
    const fd = fs.openSync(pending, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(pending, path.join(host, "generation.json"));
    return record;
  } finally {
    releaseLock();
  }
}
