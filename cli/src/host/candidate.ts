import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { businessDigest } from "./business.js";
import { readBinding } from "./binding.js";
import { assertGenerationMatchesBusiness, readGeneration } from "./generation.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertAdoptionReady, assertNoManualRuntime, assertNoPendingIntents, entryExists, readLease } from "./lease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CONTENT_BYTES = 256 * 1024;

export interface HostCandidate {
  schema: 1;
  status: "candidate";
  candidate_id: string;
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease_id: string;
  role: "ralph" | "lisa";
  generation: number;
  binding_generation: number;
  state_digest: string;
  turn: "ralph" | "lisa";
  round: number;
  step: string;
  intended_workspace_id: string;
  intended_pane_id: string;
  intended_agent_target: string;
  source_verification: "unverified";
  content_sha256: string;
  content_bytes: number;
  created_at: string;
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function regularDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid candidate directory");
  }
}

function writeExclusive(file: string, content: Buffer | string): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readCandidate(dir: string, id: string, project: string, state: string, sessionId: string): HostCandidate {
  regularDirectory(dir);
  const names = fs.readdirSync(dir).sort();
  if (names.length !== 2 || names[0] !== "content.txt" || names[1] !== "record.json") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Incomplete candidate record");
  }
  const contentFile = path.join(dir, "content.txt");
  const recordFile = path.join(dir, "record.json");
  const contentStat = fs.lstatSync(contentFile);
  const recordStat = fs.lstatSync(recordFile);
  if (!contentStat.isFile() || contentStat.isSymbolicLink() || !recordStat.isFile() || recordStat.isSymbolicLink()) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Linked or invalid candidate file");
  }
  let value: unknown;
  let bytes: Buffer;
  try {
    value = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    bytes = fs.readFileSync(contentFile);
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable candidate record");
  }
  if (!value || typeof value !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid candidate record");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || record.status !== "candidate" || record.candidate_id !== id ||
      record.project_realpath !== project || record.state_realpath !== state || record.session_id !== sessionId ||
      typeof record.lease_id !== "string" || !UUID.test(record.lease_id) ||
      (record.role !== "ralph" && record.role !== "lisa") ||
      !Number.isSafeInteger(record.generation) || (record.generation as number) < 0 ||
      !Number.isSafeInteger(record.binding_generation) || (record.binding_generation as number) < 1 ||
      typeof record.state_digest !== "string" || !SHA256.test(record.state_digest) ||
      (record.turn !== "ralph" && record.turn !== "lisa") || record.turn !== record.role ||
      !Number.isSafeInteger(record.round) || (record.round as number) < 1 ||
      typeof record.step !== "string" || !record.step ||
      typeof record.intended_workspace_id !== "string" || !record.intended_workspace_id ||
      typeof record.intended_pane_id !== "string" || !record.intended_pane_id ||
      typeof record.intended_agent_target !== "string" || !record.intended_agent_target ||
      record.source_verification !== "unverified" ||
      typeof record.content_sha256 !== "string" || !SHA256.test(record.content_sha256) ||
      record.content_bytes !== bytes.length || bytes.length === 0 || bytes.length > MAX_CONTENT_BYTES ||
      sha256(bytes) !== record.content_sha256 ||
      typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid or changed candidate record");
  }
  return record as unknown as HostCandidate;
}

/** Validate every stored candidate; a partial write freezes host snapshots. */
export function candidateInventory(host: string, project: string, state: string, sessionId: string): {
  count: number; digest: string | null; candidates: HostCandidate[];
} {
  const root = path.join(host, "candidates");
  if (!entryExists(root)) return { count: 0, digest: null, candidates: [] };
  regularDirectory(root);
  const candidates: HostCandidate[] = [];
  const hash = crypto.createHash("sha256");
  for (const id of fs.readdirSync(root).sort()) {
    if (!UUID.test(id)) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Incomplete or unknown candidate entry");
    }
    const record = readCandidate(path.join(root, id), id, project, state, sessionId);
    candidates.push(record);
    hash.update(id).update("\0").update(JSON.stringify(record)).update("\0");
  }
  return { count: candidates.length, digest: hash.digest("hex"), candidates };
}

function readProjectContent(project: string, file: string): Buffer {
  const candidatePath = path.resolve(project, file);
  if (!candidatePath.startsWith(project + path.sep) ||
      candidatePath.startsWith(path.join(project, ".dual-agent", "host") + path.sep)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--file must name a project file outside host metadata");
  }
  try {
    const real = fs.realpathSync.native(candidatePath);
    const stat = fs.lstatSync(candidatePath);
    if (!real.startsWith(project + path.sep) ||
        real.startsWith(path.join(project, ".dual-agent", "host") + path.sep) ||
        !stat.isFile() || stat.isSymbolicLink() ||
        stat.size === 0 || stat.size > MAX_CONTENT_BYTES) {
      throw new Error("invalid candidate input");
    }
    const bytes = fs.readFileSync(candidatePath);
    if (bytes.length === 0 || bytes.length > MAX_CONTENT_BYTES ||
        !new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()) {
      throw new Error("invalid candidate content");
    }
    return bytes;
  } catch {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--file must be a nonempty UTF-8 project file of at most 256 KiB");
  }
}

/** Store an immutable proposal; this cannot attest to the calling Agent's identity. */
export function proposeCandidate(project: string, role: string, file: string, candidateId: string): HostCandidate {
  if ((role !== "ralph" && role !== "lisa") || !UUID.test(candidateId)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--role must be ralph/lisa and --candidate-id a UUID");
  }
  candidateId = candidateId.toLowerCase();
  const root = canonicalProject(project);
  const bytes = readProjectContent(root, file);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id) {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for candidates");
  }
  const releaseLock = acquireHostLock(initial.state_realpath);
  try {
    const current = inspectProject(root);
    if (current.session_id !== initial.session_id || current.state_realpath !== initial.state_realpath) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    if (current.turn !== role) {
      throw new HostContractError("WRONG_SEAT", 4, "Candidate role is not the current RLL turn");
    }
    const host = path.join(current.state_realpath!, "host");
    if (!entryExists(host)) throw new HostContractError("HOST_NOT_CLAIMED", 4, "Claim the host before proposing");
    regularDirectory(host);
    assertAdoptionReady(host, current.project_realpath, current.state_realpath!, current.session_id!);
    for (const name of ["reconcile.json", "claim.lock", "lease.json", "binding.pending", "adoption.pending", "generation.pending", "receipts"]) {
      if (entryExists(path.join(host, name))) {
        throw new HostContractError("NEEDS_RECONCILE", 7, `Host metadata ${name} requires reconciliation`);
      }
    }
    assertNoPendingIntents(host);
    assertNoManualRuntime(current.project_realpath, current.state_realpath!);
    let lease;
    try {
      lease = readLease(host);
    } catch (error) {
      if (error instanceof HostContractError) throw error;
      throw new HostContractError("HOST_NOT_CLAIMED", 4, "Claim the host before proposing");
    }
    if (lease.project_realpath !== current.project_realpath || lease.state_realpath !== current.state_realpath ||
        lease.session_id !== current.session_id) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Lease belongs to another RLL session");
    }
    const binding = readBinding(host);
    if (!binding || binding.lease_id !== lease.lease_id ||
        binding.project_realpath !== current.project_realpath || binding.state_realpath !== current.state_realpath ||
        binding.session_id !== current.session_id || !binding.seats[role]) {
      throw new HostContractError("WRONG_SEAT", 4, "The current role has no binding in this lease");
    }
    const digest = businessDigest(current.state_realpath!, current.turn!, current.round!, current.step!);
    const generation = readGeneration(host, current.project_realpath, current.state_realpath!, current.session_id!);
    if (!generation) throw new HostContractError("GENERATION_REQUIRED", 5, "Prepare a generation before proposing");
    assertGenerationMatchesBusiness(generation, digest, current.turn!, current.round!, current.step!);
    const inventory = candidateInventory(host, current.project_realpath, current.state_realpath!, current.session_id!);
    const contentHash = sha256(bytes);
    const previous = inventory.candidates.find((item) => item.candidate_id === candidateId);
    const seat = binding.seats[role]!;
    if (previous) {
      if (previous.lease_id === lease.lease_id && previous.role === role &&
          previous.generation === generation.generation && previous.binding_generation === binding.binding_generation &&
          previous.state_digest === digest && previous.content_sha256 === contentHash &&
          previous.intended_workspace_id === binding.workspace_id &&
          previous.intended_pane_id === seat.pane_id && previous.intended_agent_target === seat.agent_target) {
        return previous;
      }
      throw new HostContractError("DUPLICATE_CONFLICT", 5, "Candidate ID already belongs to different content or state");
    }
    const record: HostCandidate = {
      schema: 1, status: "candidate", candidate_id: candidateId,
      project_realpath: current.project_realpath, state_realpath: current.state_realpath!,
      session_id: current.session_id!, lease_id: lease.lease_id,
      role, generation: generation.generation, binding_generation: binding.binding_generation,
      state_digest: digest, turn: current.turn!, round: current.round!, step: current.step!,
      intended_workspace_id: binding.workspace_id,
      intended_pane_id: seat.pane_id, intended_agent_target: seat.agent_target,
      source_verification: "unverified", content_sha256: contentHash,
      content_bytes: bytes.length, created_at: new Date().toISOString(),
    };
    const candidatesRoot = path.join(host, "candidates");
    if (!entryExists(candidatesRoot)) fs.mkdirSync(candidatesRoot, { mode: 0o700 });
    regularDirectory(candidatesRoot);
    const pending = path.join(candidatesRoot, `${candidateId}.pending`);
    fs.mkdirSync(pending, { mode: 0o700 });
    writeExclusive(path.join(pending, "content.txt"), bytes);
    writeExclusive(path.join(pending, "record.json"), JSON.stringify(record) + "\n");
    fs.renameSync(pending, path.join(candidatesRoot, candidateId));
    return record;
  } finally {
    releaseLock();
  }
}
