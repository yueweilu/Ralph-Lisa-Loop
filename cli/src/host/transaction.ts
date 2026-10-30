/** Durable write-ahead intent. Formal commit and receipt are separate steps. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { observedSubmissionDigest, SubmissionWritePlan, validateSubmissionPlan } from "../submission-write.js";
import { BUSINESS_FILES, businessDigest } from "./business.js";
import { readBinding } from "./binding.js";
import { candidateInventory } from "./candidate.js";
import { assertGenerationMatchesBusiness, readGeneration } from "./generation.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { assertAdoptionReady, assertNoManualRuntime, assertNoPendingIntents, entryExists, readLease } from "./lease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const WRITE_NAMES = new Set([
  "work.md", "review.md", "history.md", "last_action.txt", "turn.txt",
  "round.txt", "needs_work_count.txt", "deadlock.txt",
]);

export interface HostIntent {
  schema: 1;
  status: "prepared";
  request_id: string;
  candidate_id: string;
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease_id: string;
  role: "ralph" | "lisa";
  source_verification: "unverified";
  generation_before: number;
  binding_generation: number;
  turn_before: "ralph" | "lisa";
  round_before: number;
  step_before: string;
  turn_after: "ralph" | "lisa";
  round_after: number;
  content_sha256: string;
  state_digest_before: string;
  state_digest_after: string;
  changes: Array<{
    name: string;
    action: "write" | "delete" | "remove_tree";
    before_sha256: string | null;
    after_sha256: string | null;
  }>;
  created_at: string;
}

export interface HostIntentInput {
  project: string;
  leaseId: string;
  requestId: string;
  candidateId: string;
  expectedGeneration: number;
  expectedBindingGeneration: number;
  plan: SubmissionWritePlan;
}

export interface HostIntentAudit {
  schema: 1;
  status: "before" | "applied" | "partial";
  request_id: string;
  state_digest_observed: string | null;
  files: Array<{
    name: string;
    action: HostIntent["changes"][number]["action"];
    observed_sha256: string | null;
    matches_before: boolean;
    matches_after: boolean;
  }>;
}

function regularDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
    throw new HostContractError("NEEDS_RECONCILE", 7, `Invalid host directory: ${path.basename(dir)}`);
  }
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Predict the digest checked after business writes, without changing any file. */
export function projectedBusinessDigest(state: string, plan: SubmissionWritePlan): string {
  if (plan.stateDir !== state) throw new HostContractError("PROJECT_MISMATCH", 3, "Plan belongs to another state directory");
  validateSubmissionPlan(plan);
  const replacements = new Map(plan.changes.filter((change) => change.action === "write")
    .map((change) => [change.name, change.after_bytes!]));
  const hash = crypto.createHash("sha256");
  for (const name of BUSINESS_FILES) {
    const file = path.join(state, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new HostContractError("STATE_INVALID", 7, `Invalid business file ${name}`);
    }
    const bytes = replacements.get(name) ?? fs.readFileSync(file);
    hash.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

/** Caller must already hold acquireHostLock and have completed policy/gate checks. */
export function persistHostIntent(input: HostIntentInput): HostIntent {
  if (!UUID.test(input.requestId) || !UUID.test(input.candidateId) || !UUID.test(input.leaseId) ||
      !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 ||
      !Number.isSafeInteger(input.expectedBindingGeneration) || input.expectedBindingGeneration < 1) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid intent identifiers or expected generations");
  }
  const root = canonicalProject(input.project);
  const current = inspectProject(root);
  if (!current.initialized || !current.state_realpath || !current.session_id ||
      current.contract_state !== "identified") {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified RLL session is required for an intent");
  }
  const state = current.state_realpath;
  const host = path.join(state, "host");
  regularDirectory(host);
  assertAdoptionReady(host, root, state, current.session_id);
  assertNoPendingIntents(host);
  assertNoManualRuntime(root, state);
  const lease = readLease(host);
  if (lease.lease_id !== input.leaseId || lease.project_realpath !== root ||
      lease.state_realpath !== state || lease.session_id !== current.session_id) {
    throw new HostContractError("LEASE_MISMATCH", 4, "Intent lease differs from the active coordinator");
  }
  const binding = readBinding(host);
  if (!binding || binding.lease_id !== lease.lease_id ||
      binding.project_realpath !== root || binding.state_realpath !== state ||
      binding.session_id !== current.session_id ||
      binding.binding_generation !== input.expectedBindingGeneration ||
      !binding.seats[input.plan.role]) {
    throw new HostContractError("WRONG_SEAT", 4, "Intent seat binding is missing or stale");
  }
  const generation = readGeneration(host, root, state, current.session_id);
  if (!generation || generation.generation !== input.expectedGeneration) {
    throw new HostContractError("STALE_GENERATION", 5, "Intent generation is missing or stale");
  }
  const digestBefore = businessDigest(state, current.turn!, current.round!, current.step!);
  assertGenerationMatchesBusiness(generation, digestBefore, current.turn!, current.round!, current.step!);
  const candidate = candidateInventory(host, root, state, current.session_id).candidates
    .find((value) => value.candidate_id === input.candidateId.toLowerCase());
  if (!candidate || candidate.lease_id !== lease.lease_id ||
      candidate.generation !== generation.generation ||
      candidate.binding_generation !== binding.binding_generation ||
      candidate.state_digest !== digestBefore || candidate.role !== current.turn ||
      candidate.round !== current.round || candidate.step !== current.step ||
      candidate.content_sha256 !== input.plan.content_sha256 ||
      candidate.intended_workspace_id !== binding.workspace_id ||
      candidate.intended_pane_id !== binding.seats[candidate.role]!.pane_id ||
      candidate.intended_agent_target !== binding.seats[candidate.role]!.agent_target) {
    throw new HostContractError("STALE_CANDIDATE", 5, "Candidate differs from the planned submission");
  }
  if (input.plan.stateDir !== state || input.plan.role !== current.turn ||
      input.plan.result.round !== String(current.round) || input.plan.result.step !== current.step ||
      input.plan.result.turnAfter === current.turn ||
      input.plan.result.roundAfter !== current.round + (current.turn === "lisa" ? 1 : 0)) {
    throw new HostContractError("STALE_STATE", 5, "Submission plan differs from the current turn");
  }
  let digestAfter: string;
  try {
    digestAfter = projectedBusinessDigest(state, input.plan);
  } catch (error) {
    if (error instanceof HostContractError) throw error;
    throw new HostContractError("STALE_STATE", 5, String(error));
  }
  const record: HostIntent = {
    schema: 1, status: "prepared", request_id: input.requestId.toLowerCase(),
    candidate_id: input.candidateId.toLowerCase(), project_realpath: root,
    state_realpath: state, session_id: current.session_id, lease_id: lease.lease_id,
    role: input.plan.role, source_verification: "unverified",
    generation_before: generation.generation, binding_generation: binding.binding_generation,
    turn_before: current.turn!, round_before: current.round!, step_before: current.step!,
    turn_after: input.plan.result.turnAfter, round_after: input.plan.result.roundAfter,
    content_sha256: candidate.content_sha256, state_digest_before: digestBefore,
    state_digest_after: digestAfter,
    changes: input.plan.changes.map(({ name, action, before_sha256, after_sha256 }) =>
      ({ name, action, before_sha256, after_sha256 })),
    created_at: new Date().toISOString(),
  };

  const intents = path.join(host, "intents");
  if (!entryExists(intents)) {
    fs.mkdirSync(intents, { mode: 0o700 });
    syncDirectory(host);
  }
  regularDirectory(intents);
  const pending = path.join(intents, `${record.request_id}.pending`);
  const final = path.join(intents, `${record.request_id}.json`);
  const fd = fs.openSync(pending, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(pending, final);
  syncDirectory(intents);
  return record;
}

/** Read an immutable intent for diagnosis; it never replays a submission. */
export function readHostIntent(host: string, requestId: string): HostIntent | null {
  if (!UUID.test(requestId)) throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid request ID");
  const file = path.join(host, "intents", `${requestId.toLowerCase()}.json`);
  if (!entryExists(file)) return null;
  let value: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid intent file");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable host intent");
  }
  if (!value || typeof value !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host intent");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || record.status !== "prepared" ||
      record.request_id !== requestId.toLowerCase() ||
      typeof record.candidate_id !== "string" || !UUID.test(record.candidate_id) ||
      typeof record.project_realpath !== "string" || typeof record.state_realpath !== "string" ||
      typeof record.session_id !== "string" || typeof record.lease_id !== "string" || !UUID.test(record.lease_id) ||
      (record.role !== "ralph" && record.role !== "lisa") || record.source_verification !== "unverified" ||
      !Number.isSafeInteger(record.generation_before) || !Number.isSafeInteger(record.binding_generation) ||
      record.turn_before !== record.role || (record.turn_after !== "ralph" && record.turn_after !== "lisa") ||
      !Number.isSafeInteger(record.round_before) || !Number.isSafeInteger(record.round_after) ||
      typeof record.step_before !== "string" ||
      typeof record.content_sha256 !== "string" || !SHA256.test(record.content_sha256) ||
      typeof record.state_digest_before !== "string" || !SHA256.test(record.state_digest_before) ||
      typeof record.state_digest_after !== "string" || !SHA256.test(record.state_digest_after) ||
      !Array.isArray(record.changes) || record.changes.length === 0 ||
      new Set(record.changes.map((change: any) => change?.name)).size !== record.changes.length ||
      !record.changes.every((change: unknown) => {
        if (!change || typeof change !== "object") return false;
        const item = change as Record<string, unknown>;
        return typeof item.name === "string" &&
          ((item.action === "write" && WRITE_NAMES.has(item.name)) ||
           (item.action === "delete" && item.name === "deadlock.txt") ||
           (item.action === "remove_tree" && item.name === "tests")) &&
          (item.before_sha256 === null || (typeof item.before_sha256 === "string" && SHA256.test(item.before_sha256))) &&
          (item.action === "write"
            ? typeof item.after_sha256 === "string" && SHA256.test(item.after_sha256)
            : item.after_sha256 === null);
      }) || typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host intent");
  }
  return record as unknown as HostIntent;
}

/** Evidence only: an exact after-state still needs a durable receipt and generation update. */
export function auditHostIntent(host: string, requestId: string): HostIntentAudit {
  const intent = readHostIntent(host, requestId);
  if (!intent) throw new HostContractError("REQUEST_UNKNOWN", 5, "No intent for this request");
  if (path.join(intent.state_realpath, "host") !== host) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Intent belongs to another host directory");
  }
  const files = intent.changes.map((change) => {
    let observed: string | null = null;
    let readable = true;
    try {
      observed = observedSubmissionDigest(intent.state_realpath, change.name, change.action);
    } catch {
      // Unreadable, linked or unexpected paths are partial evidence.
      readable = false;
    }
    return { name: change.name, action: change.action, observed_sha256: observed,
      matches_before: readable && observed === change.before_sha256,
      matches_after: readable && observed === change.after_sha256 };
  });
  let stateDigest: string | null = null;
  try {
    const current = inspectProject(intent.project_realpath);
    if (current.state_realpath === intent.state_realpath && current.session_id === intent.session_id) {
      stateDigest = businessDigest(intent.state_realpath, current.turn!, current.round!, current.step!);
    }
  } catch {
    // A torn business file is represented by a null observed digest.
  }
  const status = files.every((file) => file.matches_after) &&
    stateDigest === intent.state_digest_after ? "applied"
    : files.every((file) => file.matches_before) &&
      stateDigest === intent.state_digest_before ? "before" : "partial";
  return { schema: 1, status, request_id: intent.request_id,
    state_digest_observed: stateDigest, files };
}
