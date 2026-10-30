/** Internal generation and immutable receipt writes after an audited intent. */
import * as fs from "node:fs";
import * as path from "node:path";
import { readGeneration, type GenerationRecord } from "./generation.js";
import { HostContractError } from "./inspect.js";
import { entryExists } from "./lease.js";
import { auditHostIntent, readHostIntent, type HostIntent } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface CommittedHostReceipt {
  schema: 1;
  status: "committed";
  request_id: string;
  candidate_id: string;
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease_id: string;
  role: "ralph" | "lisa";
  generation_before: number;
  generation_after: number;
  binding_generation: number;
  turn_after: "ralph" | "lisa";
  round_after: number;
  step_after: string;
  content_sha256: string;
  state_digest_after: string;
  policy: { result: "pass" | "warn"; warnings: string[] };
  gate: { result: "not_enabled" | "pass" | "warn" };
  committed_at: string;
}

export interface ReceiptChecks {
  policy: CommittedHostReceipt["policy"];
  gate: CommittedHostReceipt["gate"];
}

function regularDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host receipt directory");
  }
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeAtomicJson(pending: string, final: string, value: object, parent: string): void {
  const fd = fs.openSync(pending, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(pending, final);
  syncDirectory(parent);
}

function requiredIntent(host: string, requestId: string): HostIntent {
  const intent = readHostIntent(host, requestId);
  if (!intent) throw new HostContractError("REQUEST_UNKNOWN", 5, "No prepared intent for this request");
  if (path.join(intent.state_realpath, "host") !== host) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Intent belongs to another host directory");
  }
  return intent;
}

/** Caller holds the host lock. A crash leaves the intent as a reconciliation marker. */
export function advanceGenerationAfterIntent(host: string, requestId: string): GenerationRecord {
  const intent = requiredIntent(host, requestId);
  if (auditHostIntent(host, requestId).status !== "applied") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Business writes do not match the intent");
  }
  const prior = readGeneration(host, intent.project_realpath, intent.state_realpath, intent.session_id);
  if (!prior) throw new HostContractError("GENERATION_REQUIRED", 5, "No generation baseline");
  if (prior.generation === intent.generation_before + 1 &&
      prior.last_receipt_id === intent.request_id && prior.state_digest === intent.state_digest_after &&
      prior.turn === intent.turn_after && prior.round === intent.round_after && prior.step === intent.step_before) {
    return prior;
  }
  if (prior.generation !== intent.generation_before || prior.state_digest !== intent.state_digest_before ||
      prior.turn !== intent.turn_before || prior.round !== intent.round_before || prior.step !== intent.step_before) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Generation differs from the intent baseline");
  }
  const next: GenerationRecord = {
    ...prior, generation: prior.generation + 1, state_digest: intent.state_digest_after,
    turn: intent.turn_after, round: intent.round_after, step: intent.step_before,
    last_receipt_id: intent.request_id, updated_at: new Date().toISOString(),
  };
  writeAtomicJson(path.join(host, "generation.pending"), path.join(host, "generation.json"), next, host);
  return next;
}

/** Strictly reads a stored receipt; callers still check it against live generation. */
export function readCommittedReceipt(host: string, requestId: string): CommittedHostReceipt | null {
  if (!UUID.test(requestId)) throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid request ID");
  const receipts = path.join(host, "receipts");
  if (entryExists(receipts)) regularDirectory(receipts);
  const file = path.join(receipts, `${requestId.toLowerCase()}.json`);
  if (!entryExists(file)) return null;
  let value: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid receipt file");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable committed receipt");
  }
  if (!value || typeof value !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid committed receipt");
  }
  const r = value as Record<string, unknown>;
  const policy = r.policy as Record<string, unknown> | null;
  const gate = r.gate as Record<string, unknown> | null;
  if (r.schema !== 1 || r.status !== "committed" || r.request_id !== requestId.toLowerCase() ||
      typeof r.candidate_id !== "string" || !UUID.test(r.candidate_id) ||
      typeof r.project_realpath !== "string" || typeof r.state_realpath !== "string" ||
      typeof r.session_id !== "string" || typeof r.lease_id !== "string" || !UUID.test(r.lease_id) ||
      (r.role !== "ralph" && r.role !== "lisa") ||
      !Number.isSafeInteger(r.generation_before) || (r.generation_before as number) < 0 ||
      r.generation_after !== (r.generation_before as number) + 1 ||
      !Number.isSafeInteger(r.binding_generation) || (r.binding_generation as number) < 1 ||
      r.turn_after !== (r.role === "ralph" ? "lisa" : "ralph") ||
      !Number.isSafeInteger(r.round_after) || (r.round_after as number) < 1 ||
      typeof r.step_after !== "string" || !r.step_after ||
      typeof r.content_sha256 !== "string" || !SHA256.test(r.content_sha256) ||
      typeof r.state_digest_after !== "string" || !SHA256.test(r.state_digest_after) ||
      !policy || (policy.result !== "pass" && policy.result !== "warn") ||
      !Array.isArray(policy.warnings) || !policy.warnings.every((warning) => typeof warning === "string") ||
      !gate || !["not_enabled", "pass", "warn"].includes(gate.result as string) ||
      typeof r.committed_at !== "string" || !Number.isFinite(Date.parse(r.committed_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid committed receipt");
  }
  return r as unknown as CommittedHostReceipt;
}

/** Caller holds the host lock; no public CLI calls this while source attribution is unverified. */
export function persistCommittedReceipt(
  host: string, requestId: string, checks: ReceiptChecks
): CommittedHostReceipt {
  const intent = requiredIntent(host, requestId);
  if (auditHostIntent(host, requestId).status !== "applied") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Business writes do not match the intent");
  }
  const generation = readGeneration(host, intent.project_realpath, intent.state_realpath, intent.session_id);
  if (!generation || generation.generation !== intent.generation_before + 1 ||
      generation.last_receipt_id !== intent.request_id || generation.state_digest !== intent.state_digest_after ||
      generation.turn !== intent.turn_after || generation.round !== intent.round_after ||
      generation.step !== intent.step_before) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Generation was not advanced for this intent");
  }
  if ((checks.policy.result !== "pass" && checks.policy.result !== "warn") ||
      !Array.isArray(checks.policy.warnings) ||
      !checks.policy.warnings.every((warning) => typeof warning === "string") ||
      !["not_enabled", "pass", "warn"].includes(checks.gate.result)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Blocked or invalid checks cannot create a committed receipt");
  }
  const receipts = path.join(host, "receipts");
  if (!entryExists(receipts)) {
    fs.mkdirSync(receipts, { mode: 0o700 });
    syncDirectory(host);
  }
  regularDirectory(receipts);
  const existing = readCommittedReceipt(host, requestId);
  if (existing) {
    if (existing.candidate_id !== intent.candidate_id ||
        existing.project_realpath !== intent.project_realpath ||
        existing.state_realpath !== intent.state_realpath ||
        existing.session_id !== intent.session_id || existing.lease_id !== intent.lease_id ||
        existing.role !== intent.role || existing.generation_before !== intent.generation_before ||
        existing.generation_after !== generation.generation ||
        existing.binding_generation !== intent.binding_generation ||
        existing.turn_after !== intent.turn_after || existing.round_after !== intent.round_after ||
        existing.step_after !== intent.step_before ||
        existing.content_sha256 !== intent.content_sha256 ||
        existing.state_digest_after !== intent.state_digest_after ||
        JSON.stringify(existing.policy) !== JSON.stringify(checks.policy) ||
        JSON.stringify(existing.gate) !== JSON.stringify(checks.gate)) {
      throw new HostContractError("DUPLICATE_CONFLICT", 5, "Existing receipt differs from this request");
    }
    return existing;
  }
  const record: CommittedHostReceipt = {
    schema: 1, status: "committed", request_id: intent.request_id,
    candidate_id: intent.candidate_id, project_realpath: intent.project_realpath,
    state_realpath: intent.state_realpath, session_id: intent.session_id, lease_id: intent.lease_id,
    role: intent.role, generation_before: intent.generation_before,
    generation_after: generation.generation, binding_generation: intent.binding_generation,
    turn_after: intent.turn_after, round_after: intent.round_after, step_after: intent.step_before,
    content_sha256: intent.content_sha256, state_digest_after: intent.state_digest_after,
    policy: checks.policy, gate: checks.gate, committed_at: new Date().toISOString(),
  };
  writeAtomicJson(path.join(receipts, `${requestId.toLowerCase()}.pending`),
    path.join(receipts, `${requestId.toLowerCase()}.json`), record, receipts);
  return record;
}
