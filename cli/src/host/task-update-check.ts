/** Read-only preflight for a host-managed task change. No chat text is inferred here. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { readBinding } from "./binding.js";
import { businessDigest } from "./business.js";
import { candidateInventory } from "./candidate.js";
import { humanConfirmationInventory } from "./confirmation.js";
import { assertGenerationMatchesBusiness, readGeneration } from "./generation.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertAdoptionReady, assertNoManualRuntime,
  assertNoPendingIntents, entryExists, readLease } from "./lease.js";
import { committedReceiptLedger } from "./receipt-store.js";
import { rejectedReceiptInventory } from "./rejection.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TASK_BYTES = 64 * 1024;

export type TaskUpdateMode = "supplement" | "switch";

export interface TaskUpdatePreflight {
  schema: 1;
  status: "ready";
  project_realpath: string;
  session_id: string;
  lease_id: string;
  request_id: string;
  mode: TaskUpdateMode;
  content_sha256: string;
  generation_before: number;
  binding_generation: number;
  state_digest_before: string;
  turn_before: "ralph" | "lisa";
  round_before: number;
  step_before: string;
  target_role: "ralph" | "lisa";
  stale_candidate_ids: string[];
  last_receipt_id: string | null;
  source_verification: "unverified";
}

function taskText(project: string, file: string, expectedHash: string): void {
  if (!path.isAbsolute(file) || !SHA256.test(expectedHash))
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Task file must be absolute and its SHA-256 explicit");
  const resolved = path.resolve(file);
  if (!resolved.startsWith(project + path.sep))
    throw new HostContractError("PROJECT_MISMATCH", 3, "Task file must be inside the project");
  let bytes: Buffer;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_TASK_BYTES ||
        fs.realpathSync.native(resolved) !== resolved)
      throw new Error("invalid task file");
    bytes = fs.readFileSync(resolved);
  } catch {
    throw new HostContractError("INVALID_TASK_FILE", 2, "Task file must be a regular project file of at most 64 KiB");
  }
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash)
    throw new HostContractError("TASK_HASH_MISMATCH", 5, "Task text changed since the request was prepared");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new HostContractError("INVALID_TASK_FILE", 2, "Task text must be UTF-8"); }
  if (!text.trim() || text.includes("\0"))
    throw new HostContractError("INVALID_TASK_FILE", 2, "Task text must be nonempty plain text");
}

/** The coordinator must separately verify its delivery cursor before the write. */
export function checkTaskUpdate(project: string, leaseId: string, requestId: string,
  expectedGeneration: number, expectedBindingGeneration: number, expectedDigest: string,
  mode: TaskUpdateMode, file: string, contentSha256: string): TaskUpdatePreflight {
  if (!UUID.test(leaseId) || !UUID.test(requestId) || !SHA256.test(expectedDigest) ||
      !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 ||
      !Number.isSafeInteger(expectedBindingGeneration) || expectedBindingGeneration < 1 ||
      (mode !== "supplement" && mode !== "switch"))
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid task-update identifiers, mode, or expected state");
  const root = canonicalProject(project);
  taskText(root, file, contentSha256);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id ||
      initial.contract_state !== "identified")
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for task updates");
  const release = acquireHostLock(initial.state_realpath);
  try {
    const current = inspectProject(root);
    if (current.state_realpath !== initial.state_realpath || current.session_id !== initial.session_id)
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    const state = initial.state_realpath;
    const host = path.join(state, "host");
    if (!entryExists(host)) throw new HostContractError("HOST_NOT_CLAIMED", 4, "No Herdr host lease");
    const hostStat = fs.lstatSync(host);
    if (!hostStat.isDirectory() || hostStat.isSymbolicLink() || fs.realpathSync.native(host) !== host)
      throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host directory");
    assertAdoptionReady(host, root, state, initial.session_id);
    for (const marker of ["claim.lock", "reconcile.json", "lease.json", "binding.pending",
      "adoption.pending", "generation.pending"]) {
      if (entryExists(path.join(host, marker)))
        throw new HostContractError("NEEDS_RECONCILE", 7, `Host marker ${marker} requires reconciliation`);
    }
    assertNoPendingIntents(host);
    assertNoManualRuntime(root, state);
    const lease = readLease(host);
    if (lease.lease_id !== leaseId.toLowerCase() || lease.project_realpath !== root ||
        lease.state_realpath !== state || lease.session_id !== initial.session_id)
      throw new HostContractError("LEASE_MISMATCH", 4, "Task update belongs to another coordinator");
    const binding = readBinding(host);
    if (!binding || binding.lease_id !== lease.lease_id ||
        binding.project_realpath !== root || binding.state_realpath !== state ||
        binding.session_id !== initial.session_id ||
        binding.binding_generation !== expectedBindingGeneration ||
        !binding.seats.ralph || !binding.seats.lisa)
      throw new HostContractError("WRONG_SEAT", 4, "Task update requires the current bound pair");
    const generation = readGeneration(host, root, state, initial.session_id);
    if (!generation || generation.generation !== expectedGeneration)
      throw new HostContractError("STALE_GENERATION", 5, "Task update generation is missing or stale");
    const digest = businessDigest(state, current.turn!, current.round!, current.step!);
    assertGenerationMatchesBusiness(generation, digest, current.turn!, current.round!, current.step!);
    if (digest !== expectedDigest)
      throw new HostContractError("STALE_STATE", 5, "Business state changed since task-update request");
    const ledger = committedReceiptLedger(host, root, state, initial.session_id, generation);
    const candidates = candidateInventory(host, root, state, initial.session_id).candidates;
    rejectedReceiptInventory(host, root, state, initial.session_id, generation, ledger, candidates);
    humanConfirmationInventory(host, root, state, initial.session_id, generation, ledger, candidates);
    if (ledger.receipts.some((receipt) => receipt.request_id === requestId.toLowerCase()) ||
        entryExists(path.join(host, "archived-intents", `${requestId.toLowerCase()}.json`)))
      throw new HostContractError("DUPLICATE_CONFLICT", 5, "Request ID already belongs to a submission");
    return {
      schema: 1, status: "ready", project_realpath: root, session_id: initial.session_id,
      lease_id: lease.lease_id, request_id: requestId.toLowerCase(), mode,
      content_sha256: contentSha256, generation_before: generation.generation,
      binding_generation: binding.binding_generation, state_digest_before: digest,
      turn_before: current.turn!, round_before: current.round!, step_before: current.step!,
      target_role: mode === "switch" ? "ralph" : current.turn!,
      stale_candidate_ids: candidates.filter((candidate) => candidate.generation === generation.generation)
        .map((candidate) => candidate.candidate_id),
      last_receipt_id: generation.last_receipt_id, source_verification: "unverified",
    };
  } finally { release(); }
}
