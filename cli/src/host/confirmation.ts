/** A human assertion about one candidate; it is never a Herdr identity proof. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkHostCommitLocked } from "./commit-check.js";
import { candidateInventory, type HostCandidate } from "./candidate.js";
import { readGeneration, type GenerationRecord } from "./generation.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertNoPendingIntents, entryExists } from "./lease.js";
import { committedReceiptLedger, type CommittedReceiptLedger } from "./receipt-store.js";
import { readArchivedHostIntent } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface HumanSourceConfirmation {
  schema: 1;
  status: "human_asserted";
  decision: "reviewed_candidate_source";
  request_id: string;
  candidate_id: string;
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease_id: string;
  role: "ralph" | "lisa";
  generation: number;
  binding_generation: number;
  turn: "ralph" | "lisa";
  round: number;
  step: string;
  state_digest: string;
  content_sha256: string;
  workspace_id: string;
  pane_id: string;
  agent_target: string;
  source_verification: "unverified";
  asserted_at: string;
}

interface ConfirmationIndex {
  schema: 1;
  request_ids: string[];
  confirmations_digest: string;
}

function regularDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid confirmation directory");
  }
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function indexFor(records: HumanSourceConfirmation[]): ConfirmationIndex {
  const sorted = [...records].sort((a, b) => a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0);
  const hash = crypto.createHash("sha256");
  for (const record of sorted) hash.update(JSON.stringify(record)).update("\n");
  return { schema: 1, request_ids: sorted.map((record) => record.request_id),
    confirmations_digest: hash.digest("hex") };
}

function readIndex(dir: string): ConfirmationIndex {
  let value: unknown;
  try {
    const file = path.join(dir, "index.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid index");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Confirmation index is missing or unreadable");
  }
  const index = value as Partial<ConfirmationIndex> | null;
  if (!index || index.schema !== 1 || !Array.isArray(index.request_ids) ||
      index.request_ids.length === 0 || !index.request_ids.every((id) => typeof id === "string" && UUID.test(id)) ||
      JSON.stringify(index.request_ids) !== JSON.stringify([...index.request_ids].sort()) ||
      !SHA256.test(index.confirmations_digest ?? "")) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid confirmation index");
  }
  return index as ConfirmationIndex;
}

function writeIndex(dir: string, index: ConfirmationIndex): void {
  const pending = path.join(dir, "index.pending");
  const fd = fs.openSync(pending, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(index) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(pending, path.join(dir, "index.json"));
  syncDirectory(dir);
}

export function readHumanConfirmation(host: string, requestId: string): HumanSourceConfirmation | null {
  if (!UUID.test(requestId)) throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid request ID");
  const dir = path.join(host, "confirmations");
  if (!entryExists(dir)) return null;
  regularDirectory(dir);
  const file = path.join(dir, `${requestId.toLowerCase()}.json`);
  if (!entryExists(file)) return null;
  let value: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid confirmation");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable confirmation record");
  }
  const r = value as Partial<HumanSourceConfirmation> | null;
  if (!r || r.schema !== 1 || r.status !== "human_asserted" ||
      r.decision !== "reviewed_candidate_source" || r.request_id !== requestId.toLowerCase() ||
      !UUID.test(r.candidate_id ?? "") || !UUID.test(r.lease_id ?? "") ||
      typeof r.project_realpath !== "string" || typeof r.state_realpath !== "string" ||
      typeof r.session_id !== "string" || (r.role !== "ralph" && r.role !== "lisa") ||
      !Number.isSafeInteger(r.generation) || (r.generation ?? -1) < 0 ||
      !Number.isSafeInteger(r.binding_generation) || (r.binding_generation ?? 0) < 1 ||
      r.turn !== r.role || !Number.isSafeInteger(r.round) || (r.round ?? 0) < 1 ||
      typeof r.step !== "string" || !r.step || !SHA256.test(r.state_digest ?? "") ||
      !SHA256.test(r.content_sha256 ?? "") ||
      typeof r.workspace_id !== "string" || !r.workspace_id ||
      typeof r.pane_id !== "string" || !r.pane_id ||
      typeof r.agent_target !== "string" || !r.agent_target ||
      r.source_verification !== "unverified" ||
      typeof r.asserted_at !== "string" || !Number.isFinite(Date.parse(r.asserted_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid confirmation record");
  }
  return r as HumanSourceConfirmation;
}

/** Validate all assertions against immutable candidates and the state at their generation. */
export function humanConfirmationInventory(
  host: string, project: string, state: string, sessionId: string,
  generation: GenerationRecord | null, ledger: CommittedReceiptLedger, candidates: HostCandidate[]
): { confirmations: HumanSourceConfirmation[]; digest: string | null } {
  const dir = path.join(host, "confirmations");
  if (!entryExists(dir)) return { confirmations: [], digest: null };
  regularDirectory(dir);
  assertNoPendingIntents(host);
  const names = fs.readdirSync(dir).sort();
  const index = readIndex(dir);
  const recordNames = names.filter((name) => name !== "index.json");
  if (!generation || recordNames.length === 0 || recordNames.some((name) =>
      !name.endsWith(".json") || !UUID.test(name.slice(0, -5)) || name !== name.toLowerCase())) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Confirmation inventory is incomplete");
  }
  const baseline = ledger.receipts.length > 0
    ? readArchivedHostIntent(host, ledger.receipts[0].request_id) : null;
  if (ledger.receipts.length > 0 && !baseline) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Confirmation baseline is missing");
  }
  const confirmations = recordNames.map((name) => {
    const record = readHumanConfirmation(host, name.slice(0, -5));
    const candidate = candidates.find((item) => item.candidate_id === record?.candidate_id);
    const committed = ledger.receipts.find((item) => item.request_id === record?.request_id);
    const previous = record && record.generation > 0 ? ledger.receipts[record.generation - 1] : null;
    const expected = previous
      ? { digest: previous.state_digest_after, turn: previous.turn_after,
          round: previous.round_after, step: previous.step_after }
      : baseline
        ? { digest: baseline.state_digest_before, turn: baseline.turn_before,
            round: baseline.round_before, step: baseline.step_before }
        : { digest: generation.state_digest, turn: generation.turn,
            round: generation.round, step: generation.step };
    if (!record || record.generation > generation.generation ||
        (record.generation > 0 && !previous) ||
        record.project_realpath !== project || record.state_realpath !== state ||
        record.session_id !== sessionId || path.join(state, "host") !== host ||
        record.state_digest !== expected.digest || record.turn !== expected.turn ||
        record.round !== expected.round || record.step !== expected.step ||
        !candidate || candidate.project_realpath !== project ||
        candidate.state_realpath !== state || candidate.session_id !== sessionId ||
        candidate.lease_id !== record.lease_id || candidate.role !== record.role ||
        candidate.generation !== record.generation ||
        candidate.binding_generation !== record.binding_generation ||
        candidate.state_digest !== record.state_digest || candidate.turn !== record.turn ||
        candidate.round !== record.round || candidate.step !== record.step ||
        candidate.content_sha256 !== record.content_sha256 ||
        candidate.intended_workspace_id !== record.workspace_id ||
        candidate.intended_pane_id !== record.pane_id ||
        candidate.intended_agent_target !== record.agent_target ||
        (committed && (committed.candidate_id !== record.candidate_id ||
          committed.lease_id !== record.lease_id || committed.role !== record.role ||
          committed.generation_before !== record.generation ||
          committed.binding_generation !== record.binding_generation ||
          committed.content_sha256 !== record.content_sha256))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Confirmation differs from candidate or generation");
    }
    return record;
  });
  const calculated = indexFor(confirmations);
  if (JSON.stringify(index) !== JSON.stringify(calculated)) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Confirmation index differs from history");
  }
  return { confirmations, digest: calculated.confirmations_digest };
}

/** An explicit operator assertion. The CLI cannot prove who reviewed the candidate. */
export function confirmCandidateSource(
  project: string, leaseId: string, requestId: string, candidateId: string,
  expectedGeneration: number, expectedBindingGeneration: number,
  expectedContentSha256: string, decision: string
): HumanSourceConfirmation {
  if (decision !== "reviewed_candidate_source" || !SHA256.test(expectedContentSha256)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Expected candidate digest and review decision are required");
  }
  const root = canonicalProject(project);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id ||
      initial.contract_state !== "identified") {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for confirmation");
  }
  const release = acquireHostLock(initial.state_realpath);
  try {
    const check = checkHostCommitLocked(root, leaseId, requestId, candidateId,
      expectedGeneration, expectedBindingGeneration);
    if (check.status === "policy_blocked") {
      throw new HostContractError("POLICY_BLOCKED", 6, "Policy blocked this candidate");
    }
    if (check.content_sha256 !== expectedContentSha256) {
      throw new HostContractError("STALE_CANDIDATE", 5, "Reviewed candidate digest differs from stored content");
    }
    const state = initial.state_realpath;
    const host = path.join(state, "host");
    const generation = readGeneration(host, root, state, initial.session_id);
    const ledger = committedReceiptLedger(host, root, state, initial.session_id, generation);
    const candidates = candidateInventory(host, root, state, initial.session_id).candidates;
    const prior = humanConfirmationInventory(host, root, state, initial.session_id,
      generation, ledger, candidates);
    const existing = prior.confirmations.find((item) => item.request_id === requestId.toLowerCase());
    if (existing) {
      if (existing.candidate_id !== candidateId.toLowerCase() ||
          existing.lease_id !== leaseId.toLowerCase() ||
          existing.generation !== expectedGeneration ||
          existing.binding_generation !== expectedBindingGeneration ||
          existing.content_sha256 !== expectedContentSha256) {
        throw new HostContractError("DUPLICATE_CONFLICT", 5, "Confirmation request ID already belongs to another candidate");
      }
      return existing;
    }
    const record: HumanSourceConfirmation = {
      schema: 1, status: "human_asserted", decision: "reviewed_candidate_source",
      request_id: requestId.toLowerCase(), candidate_id: candidateId.toLowerCase(),
      project_realpath: root, state_realpath: state, session_id: initial.session_id,
      lease_id: leaseId.toLowerCase(), role: check.role, generation: expectedGeneration,
      binding_generation: expectedBindingGeneration, turn: check.turn_before,
      round: check.round_before, step: check.step_before, state_digest: check.state_digest_before,
      content_sha256: expectedContentSha256, workspace_id: check.workspace_id,
      pane_id: check.pane_id, agent_target: check.agent_target,
      source_verification: "unverified", asserted_at: new Date().toISOString(),
    };
    const dir = path.join(host, "confirmations");
    if (!entryExists(dir)) {
      fs.mkdirSync(dir, { mode: 0o700 });
      syncDirectory(host);
    }
    regularDirectory(dir);
    const pending = path.join(dir, `${record.request_id}.pending`);
    const fd = fs.openSync(pending, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(pending, path.join(dir, `${record.request_id}.json`));
    syncDirectory(dir);
    writeIndex(dir, indexFor([...prior.confirmations, record]));
    return record;
  } finally { release(); }
}
