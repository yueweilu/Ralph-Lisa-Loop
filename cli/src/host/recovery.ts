import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "../state.js";
import { readBinding } from "./binding.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertAdoptionReady, assertNoManualRuntime, assertNoPendingIntents, entryExists, HostLease, readLease } from "./lease.js";
import { businessDigest } from "./business.js";
import { assertGenerationMatchesBusiness, GenerationRecord, readGeneration } from "./generation.js";
import { candidateInventory } from "./candidate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

interface Evidence {
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease: HostLease;
  state_digest: string;
  binding_generation: number | null;
  binding_lease_id: string | null;
  generation: GenerationRecord | null;
  candidate_count: number;
  candidates_digest: string | null;
  evidence_sha256: string;
  host_dir: string;
}

function regularDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
    throw new HostContractError("NEEDS_RECONCILE", 7, `Invalid host directory: ${path.basename(dir)}`);
  }
}

function writeExclusiveJson(file: string, value: object): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function existingOrCreateDirectory(dir: string): void {
  if (!entryExists(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  regularDirectory(dir);
}

function collect(project: string): Evidence {
  const current = inspectProject(project);
  if (!current.initialized || !current.state_realpath || !current.session_id) {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified RLL session is required for lease recovery");
  }
  const host = path.join(current.state_realpath, "host");
  if (!entryExists(host)) throw new HostContractError("HOST_NOT_CLAIMED", 4, "No host lease to recover");
  regularDirectory(host);
  assertAdoptionReady(host, current.project_realpath, current.state_realpath, current.session_id);
  for (const name of ["reconcile.json", "claim.lock", "lease.json", "binding.pending", "adoption.pending", "generation.pending"]) {
    if (entryExists(path.join(host, name))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Host marker ${name} requires reconciliation`);
    }
  }
  for (const name of ["receipts"]) {
    if (entryExists(path.join(host, name))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Unsupported host metadata during lease recovery: ${name}`);
    }
  }
  assertNoPendingIntents(host);
  assertNoManualRuntime(current.project_realpath, current.state_realpath);
  let lease: HostLease;
  try {
    lease = readLease(host);
  } catch (error) {
    if (error instanceof HostContractError) throw error;
    throw new HostContractError("HOST_NOT_CLAIMED", 4, "No complete host lease to recover");
  }
  if (lease.project_realpath !== current.project_realpath || lease.state_realpath !== current.state_realpath ||
      lease.session_id !== current.session_id) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Lease belongs to another RLL session");
  }
  const binding = readBinding(host);
  if (binding && (binding.project_realpath !== current.project_realpath ||
      binding.state_realpath !== current.state_realpath || binding.session_id !== current.session_id)) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Binding belongs to another RLL session");
  }
  const stateDigest = businessDigest(current.state_realpath, current.turn!, current.round!, current.step!);
  const generation = readGeneration(host, current.project_realpath, current.state_realpath, current.session_id);
  if (generation) {
    assertGenerationMatchesBusiness(generation, stateDigest, current.turn!, current.round!, current.step!);
  }
  const candidates = candidateInventory(host, current.project_realpath, current.state_realpath, current.session_id);
  const body = {
    project_realpath: current.project_realpath,
    state_realpath: current.state_realpath,
    session_id: current.session_id,
    lease,
    state_digest: stateDigest,
    binding_generation: binding?.binding_generation ?? null,
    binding_lease_id: binding?.lease_id ?? null,
    generation,
    candidate_count: candidates.count,
    candidates_digest: candidates.digest,
  };
  return {
    ...body,
    evidence_sha256: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    host_dir: host,
  };
}

/** Read-only evidence for a person to compare with the actual coordinator and Herdr session. */
export function leaseRecoveryCheck(project: string): object {
  const root = canonicalProject(project);
  const releaseLock = acquireHostLock(path.join(root, STATE_DIR));
  try {
    const evidence = collect(root);
    return {
      schema: 1, status: "review_required",
      project_realpath: evidence.project_realpath,
      session_id: evidence.session_id,
      lease_id: evidence.lease.lease_id,
      owner_id: evidence.lease.owner_id,
      claimed_at: evidence.lease.claimed_at,
      heartbeat_seq: evidence.lease.heartbeat_seq ?? null,
      heartbeat_at: evidence.lease.heartbeat_at ?? null,
      binding_generation: evidence.binding_generation,
      generation: evidence.generation?.generation ?? null,
      candidate_count: evidence.candidate_count,
      state_digest: evidence.state_digest,
      evidence_sha256: evidence.evidence_sha256,
      required_checks: ["coordinator_stopped", "herdr_agents_stopped", "no_unrecorded_delivery"],
    };
  } finally {
    releaseLock();
  }
}

/** Archive an explicitly reviewed lease. A partial archive leaves reconcile.json in place. */
export function recoverLease(project: string, leaseId: string, expectedEvidence: string, decision: string): object {
  if (!UUID.test(leaseId) || !SHA256.test(expectedEvidence) || decision !== "verified-stopped-no-replay") {
    throw new HostContractError("INVALID_ARGUMENTS", 2,
      "--lease-id must be a UUID, --expected-evidence a SHA-256, and --decision verified-stopped-no-replay");
  }
  const root = canonicalProject(project);
  const releaseLock = acquireHostLock(path.join(root, STATE_DIR));
  try {
    const evidence = collect(root);
    if (evidence.lease.lease_id !== leaseId) {
      throw new HostContractError("LEASE_MISMATCH", 4, "Lease changed since recovery review");
    }
    if (evidence.evidence_sha256 !== expectedEvidence) {
      throw new HostContractError("RECOVERY_STALE", 5, "Lease, binding, or business state changed since recovery review");
    }
    const host = evidence.host_dir;
    const retired = path.join(host, "retired-leases");
    const archive = path.join(retired, leaseId);
    const recoveries = path.join(host, "recoveries");
    if (entryExists(archive)) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "This lease already has a recovery archive");
    }
    if (entryExists(retired)) regularDirectory(retired);
    if (entryExists(recoveries)) regularDirectory(recoveries);
    const recoveryId = crypto.randomUUID();
    const marker = path.join(host, "reconcile.json");
    writeExclusiveJson(marker, {
      schema: 1, kind: "lease_recovery", status: "archiving", recovery_id: recoveryId,
      lease_id: leaseId, evidence_sha256: expectedEvidence,
    });
    existingOrCreateDirectory(retired);
    existingOrCreateDirectory(recoveries);
    fs.renameSync(path.join(host, "lease"), archive);
    writeExclusiveJson(path.join(recoveries, `${recoveryId}.json`), {
      schema: 1, status: "recovered", recovery_id: recoveryId,
      session_id: evidence.session_id, lease_id: leaseId, owner_id: evidence.lease.owner_id,
      last_heartbeat_seq: evidence.lease.heartbeat_seq ?? null,
      last_heartbeat_at: evidence.lease.heartbeat_at ?? null,
      state_digest: evidence.state_digest, binding_generation: evidence.binding_generation,
      generation: evidence.generation?.generation ?? null,
      candidate_count: evidence.candidate_count,
      evidence_sha256: expectedEvidence, decision, replay: "not_replayed",
      recovered_at: new Date().toISOString(),
    });
    fs.unlinkSync(marker);
    return {
      schema: 1, status: "recovered", recovery_id: recoveryId,
      session_id: evidence.session_id, lease_id: leaseId,
      archive_relative_path: path.join(STATE_DIR, "host", "retired-leases", leaseId),
      replay: "not_replayed",
    };
  } finally {
    releaseLock();
  }
}
