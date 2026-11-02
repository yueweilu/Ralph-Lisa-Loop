/** Internal generation and immutable receipt writes after an audited intent. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readGeneration, type GenerationRecord } from "./generation.js";
import { HostContractError } from "./inspect.js";
import { assertNoPendingIntents, entryExists } from "./lease.js";
import { auditHostIntent, auditHostIntentRecord, readArchivedHostIntent, readHostIntent, type HostIntent } from "./transaction.js";

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
  source_confirmation?: "human_asserted";
  source_verification?: "unverified";
  policy: { result: "pass" | "warn"; warnings: string[] };
  gate: { result: "not_enabled" | "pass" | "warn" };
  committed_at: string;
}

export interface ReceiptChecks {
  policy: CommittedHostReceipt["policy"];
  gate: CommittedHostReceipt["gate"];
  source_confirmation?: "human_asserted";
  source_verification?: "unverified";
}

export interface CommittedReceiptLedger {
  count: number;
  digest: string | null;
  receipts: CommittedHostReceipt[];
  latest: CommittedHostReceipt | null;
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
      ((r.source_confirmation !== undefined || r.source_verification !== undefined) &&
        (r.source_confirmation !== "human_asserted" || r.source_verification !== "unverified")) ||
      !policy || (policy.result !== "pass" && policy.result !== "warn") ||
      !Array.isArray(policy.warnings) || !policy.warnings.every((warning) => typeof warning === "string") ||
      !gate || !["not_enabled", "pass", "warn"].includes(gate.result as string) ||
      typeof r.committed_at !== "string" || !Number.isFinite(Date.parse(r.committed_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid committed receipt");
  }
  return r as unknown as CommittedHostReceipt;
}

/** Check every archived intent and receipt before a later generation is considered ready. */
export function committedReceiptLedger(
  host: string, project: string, state: string, sessionId: string, generation: GenerationRecord | null,
  activeLatestRequestId?: string
): CommittedReceiptLedger {
  const receiptsDir = path.join(host, "receipts");
  const archiveDir = path.join(host, "archived-intents");
  if (!entryExists(receiptsDir)) {
    if (entryExists(archiveDir)) {
      regularDirectory(archiveDir);
      if (fs.readdirSync(archiveDir).length > 0) {
        throw new HostContractError("NEEDS_RECONCILE", 7, "Archived intents have no receipts");
      }
    }
    if (generation && generation.generation > 0) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Generation has no committed receipts");
    }
    return { count: 0, digest: null, receipts: [], latest: null };
  }
  regularDirectory(receiptsDir);
  const pendingId = activeLatestRequestId?.toLowerCase();
  if (pendingId) {
    if (!UUID.test(pendingId)) throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid active request ID");
    const intentsDir = path.join(host, "intents");
    regularDirectory(intentsDir);
    if (JSON.stringify(fs.readdirSync(intentsDir)) !== JSON.stringify([`${pendingId}.json`])) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Unexpected pending host intent");
    }
  } else {
    assertNoPendingIntents(host);
  }
  const receiptNames = fs.readdirSync(receiptsDir).sort();
  const expectedArchiveNames = receiptNames.filter((name) => name !== `${pendingId}.json`);
  let archiveNames: string[] = [];
  if (entryExists(archiveDir)) {
    regularDirectory(archiveDir);
    archiveNames = fs.readdirSync(archiveDir).sort();
  }
  if (!generation || receiptNames.length === 0 ||
      receiptNames.length !== generation.generation ||
      (pendingId && !receiptNames.includes(`${pendingId}.json`)) ||
      JSON.stringify(expectedArchiveNames) !== JSON.stringify(archiveNames) ||
      receiptNames.some((name) => !name.endsWith(".json") ||
        !UUID.test(name.slice(0, -5)) || name !== name.toLowerCase())) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Committed receipt inventory is incomplete");
  }
  const pairs = receiptNames.map((name) => {
    const id = name.slice(0, -5);
    const receipt = readCommittedReceipt(host, id);
    const intent = id === pendingId ? readHostIntent(host, id) : readArchivedHostIntent(host, id);
    if (!receipt || !intent || path.join(state, "host") !== host ||
        receipt.project_realpath !== project || receipt.state_realpath !== state ||
        receipt.session_id !== sessionId || intent.project_realpath !== project ||
        intent.state_realpath !== state || intent.session_id !== sessionId ||
        receipt.request_id !== intent.request_id || receipt.candidate_id !== intent.candidate_id ||
        receipt.lease_id !== intent.lease_id || receipt.role !== intent.role ||
        receipt.generation_before !== intent.generation_before ||
        receipt.binding_generation !== intent.binding_generation ||
        receipt.turn_after !== intent.turn_after || receipt.round_after !== intent.round_after ||
        receipt.step_after !== intent.step_before || receipt.content_sha256 !== intent.content_sha256 ||
        receipt.state_digest_after !== intent.state_digest_after ||
        (receipt.source_confirmation === "human_asserted" &&
          !entryExists(path.join(host, "confirmations", `${id}.json`))) ||
        intent.turn_after === intent.turn_before ||
        intent.round_after !== intent.round_before + (intent.role === "lisa" ? 1 : 0)) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Committed receipt differs from archived intent");
    }
    return { receipt, intent };
  }).sort((a, b) => a.receipt.generation_before - b.receipt.generation_before);
  const hash = crypto.createHash("sha256");
  for (let index = 0; index < pairs.length; index++) {
    const { receipt, intent } = pairs[index];
    const previous = pairs[index - 1]?.receipt;
    if (receipt.generation_before !== index || receipt.generation_after !== index + 1 ||
        (previous && (intent.state_digest_before !== previous.state_digest_after ||
          intent.turn_before !== previous.turn_after || intent.round_before !== previous.round_after ||
          intent.step_before !== previous.step_after))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Committed receipt chain has a gap or changed transition");
    }
    hash.update(JSON.stringify({ receipt, intent })).update("\n");
  }
  const receipts = pairs.map(({ receipt }) => receipt);
  const latest = receipts[receipts.length - 1];
  if ((pendingId && latest.request_id !== pendingId) ||
      generation.last_receipt_id !== latest.request_id ||
      generation.state_digest !== latest.state_digest_after || generation.turn !== latest.turn_after ||
      generation.round !== latest.round_after || generation.step !== latest.step_after) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Latest receipt differs from generation");
  }
  return { count: receipts.length, digest: hash.digest("hex"), receipts, latest };
}

/** Only the latest receipt can be checked against live business state. */
export function verifyLatestCommittedReceipt(
  host: string, requestId: string, project: string, state: string, sessionId: string
): CommittedHostReceipt | null {
  const receipt = readCommittedReceipt(host, requestId);
  if (!receipt) return null;
  const active = readHostIntent(host, requestId);
  const archived = readArchivedHostIntent(host, requestId);
  if (active && archived) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Intent appears in both active and archived stores");
  }
  const intent = active ?? archived;
  if (!intent || path.join(state, "host") !== host ||
      receipt.project_realpath !== project || receipt.state_realpath !== state ||
      receipt.session_id !== sessionId || intent.project_realpath !== project ||
      intent.state_realpath !== state || intent.session_id !== sessionId ||
      receipt.request_id !== intent.request_id || receipt.candidate_id !== intent.candidate_id ||
      receipt.lease_id !== intent.lease_id || receipt.role !== intent.role ||
      receipt.generation_before !== intent.generation_before ||
      receipt.generation_after !== intent.generation_before + 1 ||
      receipt.binding_generation !== intent.binding_generation ||
      receipt.turn_after !== intent.turn_after || receipt.round_after !== intent.round_after ||
      receipt.step_after !== intent.step_before ||
      receipt.content_sha256 !== intent.content_sha256 ||
      receipt.state_digest_after !== intent.state_digest_after) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Committed receipt differs from its intent");
  }
  const generation = readGeneration(host, project, state, sessionId);
  if (!generation || generation.generation !== receipt.generation_after ||
      generation.last_receipt_id !== receipt.request_id ||
      generation.state_digest !== receipt.state_digest_after ||
      generation.turn !== receipt.turn_after || generation.round !== receipt.round_after ||
      generation.step !== receipt.step_after ||
      auditHostIntentRecord(intent).status !== "applied") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Committed receipt differs from live generation or business state");
  }
  committedReceiptLedger(host, project, state, sessionId, generation, active ? requestId : undefined);
  return receipt;
}

/** Caller holds the host lock; move only a fully verified intent out of the pending set. */
export function archiveCommittedIntent(host: string, requestId: string): CommittedHostReceipt {
  const active = readHostIntent(host, requestId);
  const archived = readArchivedHostIntent(host, requestId);
  if (active && archived) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Intent appears in both active and archived stores");
  }
  const intent = active ?? archived;
  if (!intent) throw new HostContractError("REQUEST_UNKNOWN", 5, "No intent for this request");
  const receipt = verifyLatestCommittedReceipt(host, requestId,
    intent.project_realpath, intent.state_realpath, intent.session_id);
  if (!receipt) throw new HostContractError("NEEDS_RECONCILE", 7, "No committed receipt for this intent");
  if (archived) return receipt;
  const archive = path.join(host, "archived-intents");
  if (!entryExists(archive)) {
    fs.mkdirSync(archive, { mode: 0o700 });
    syncDirectory(host);
  }
  regularDirectory(archive);
  const final = path.join(archive, `${requestId.toLowerCase()}.json`);
  if (entryExists(final)) throw new HostContractError("NEEDS_RECONCILE", 7, "Archived intent already exists");
  fs.renameSync(path.join(host, "intents", `${requestId.toLowerCase()}.json`), final);
  syncDirectory(path.join(host, "intents"));
  syncDirectory(archive);
  return receipt;
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
      ((checks.source_confirmation !== undefined || checks.source_verification !== undefined) &&
        (checks.source_confirmation !== "human_asserted" || checks.source_verification !== "unverified")) ||
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
        existing.source_confirmation !== checks.source_confirmation ||
        existing.source_verification !== checks.source_verification ||
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
    ...(checks.source_confirmation ? {
      source_confirmation: checks.source_confirmation,
      source_verification: checks.source_verification,
    } : {}),
    policy: checks.policy, gate: checks.gate, committed_at: new Date().toISOString(),
  };
  writeAtomicJson(path.join(receipts, `${requestId.toLowerCase()}.pending`),
    path.join(receipts, `${requestId.toLowerCase()}.json`), record, receipts);
  return record;
}
