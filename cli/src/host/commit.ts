/** Controlled submission after an explicit human candidate-source assertion. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { type GateRunner } from "../gate.js";
import { extractTag } from "../state.js";
import { applySubmissionPlan, prepareLisaSubmission, prepareRalphSubmission } from "../submission-write.js";
import { candidateInventory } from "./candidate.js";
import { checkHostCommitLocked } from "./commit-check.js";
import { humanConfirmationInventory } from "./confirmation.js";
import { assertGenerationMatchesBusiness, readGeneration } from "./generation.js";
import { businessDigest } from "./business.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, entryExists } from "./lease.js";
import { checkAndPersistBlockedSubmission, rejectedReceiptInventory, type RejectedHostReceipt } from "./rejection.js";
import {
  advanceGenerationAfterIntent, archiveCommittedIntent, committedReceiptLedger,
  persistCommittedReceipt, readCommittedReceipt, type CommittedHostReceipt,
} from "./receipt-store.js";
import { persistHostIntent, readHostIntent } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_LOCK_WAIT_MS = 500;
const COMMIT_LOCK_RETRY_MS = 25;
const commitLockWaiter = new Int32Array(new SharedArrayBuffer(4));

export type HostCommitOutcome = CommittedHostReceipt | RejectedHostReceipt;

function acquireCommitLock(state: string): () => void {
  const deadline = Date.now() + COMMIT_LOCK_WAIT_MS;
  for (;;) {
    try { return acquireHostLock(state); }
    catch (error) {
      if (!(error instanceof HostContractError) || error.code !== "HOST_BUSY" || Date.now() >= deadline)
        throw error;
      // The lock was not acquired and no commit write has begun. Wait briefly
      // for a heartbeat or other short command, then validate everything anew.
      Atomics.wait(commitLockWaiter, 0, 0, Math.min(COMMIT_LOCK_RETRY_MS, deadline - Date.now()));
    }
  }
}

function matchesRequest(
  outcome: HostCommitOutcome, leaseId: string, requestId: string, candidateId: string,
  generation: number, bindingGeneration: number
): boolean {
  return outcome.request_id === requestId && outcome.candidate_id === candidateId &&
    outcome.lease_id === leaseId && outcome.binding_generation === bindingGeneration &&
    (outcome.status === "committed" ? outcome.generation_before : outcome.generation) === generation;
}

/** Caller holds the host lock. Return only a fully checked durable outcome. */
function existingOutcome(
  host: string, project: string, state: string, sessionId: string,
  leaseId: string, requestId: string, candidateId: string,
  expectedGeneration: number, expectedBindingGeneration: number,
  turn: "ralph" | "lisa", round: number, step: string
): HostCommitOutcome | null {
  // The receipt may have been fsynced just before a crash that prevented archival.
  const active = readHostIntent(host, requestId);
  const pendingReceipt = active ? readCommittedReceipt(host, requestId) : null;
  if (pendingReceipt) {
    if (!matchesRequest(pendingReceipt, leaseId, requestId, candidateId,
        expectedGeneration, expectedBindingGeneration)) {
      throw new HostContractError("DUPLICATE_CONFLICT", 5, "Request ID belongs to a different submission");
    }
    archiveCommittedIntent(host, requestId);
  }
  const generation = readGeneration(host, project, state, sessionId);
  const ledger = committedReceiptLedger(host, project, state, sessionId, generation);
  const candidates = candidateInventory(host, project, state, sessionId).candidates;
  const rejections = rejectedReceiptInventory(host, project, state, sessionId,
    generation, ledger, candidates);
  humanConfirmationInventory(host, project, state, sessionId, generation, ledger, candidates);
  if (generation) {
    assertGenerationMatchesBusiness(generation, businessDigest(state, turn, round, step), turn, round, step);
  }
  const outcome = ledger.receipts.find((item) => item.request_id === requestId) ??
    rejections.receipts.find((item) => item.request_id === requestId) ?? null;
  if (outcome && !matchesRequest(outcome, leaseId, requestId, candidateId,
      expectedGeneration, expectedBindingGeneration)) {
    throw new HostContractError("DUPLICATE_CONFLICT", 5, "Request ID belongs to a different submission");
  }
  return outcome;
}

/** This path does not claim Herdr verified the source. A matching human assertion is required. */
export function commitHostCandidate(
  project: string, leaseId: string, requestId: string, candidateId: string,
  expectedGeneration: number, expectedBindingGeneration: number,
  gateRunner?: GateRunner
): HostCommitOutcome {
  if (!UUID.test(leaseId) || !UUID.test(requestId) || !UUID.test(candidateId) ||
      !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 ||
      !Number.isSafeInteger(expectedBindingGeneration) || expectedBindingGeneration < 1) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid commit identifiers or generations");
  }
  leaseId = leaseId.toLowerCase();
  requestId = requestId.toLowerCase();
  candidateId = candidateId.toLowerCase();
  const root = canonicalProject(project);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id ||
      initial.contract_state !== "identified") {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for commit");
  }
  const state = initial.state_realpath;
  const release = acquireCommitLock(state);
  try {
    const current = inspectProject(root);
    if (current.state_realpath !== state || current.session_id !== initial.session_id) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    const host = path.join(state, "host");
    const old = existingOutcome(host, root, state, initial.session_id, leaseId, requestId,
      candidateId, expectedGeneration, expectedBindingGeneration,
      current.turn!, current.round!, current.step!);
    if (old) return old;
    const check = checkHostCommitLocked(root, leaseId, requestId, candidateId,
      expectedGeneration, expectedBindingGeneration);
    if (check.status !== "policy_blocked" && check.human_confirmation !== "asserted") {
      throw new HostContractError("SOURCE_CONFIRMATION_REQUIRED", 5,
        "Confirm this candidate source before running the gate or changing business state");
    }
    const file = path.join(host, "candidates", candidateId, "content.txt");
    let content: string;
    try {
      const bytes = fs.readFileSync(file);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== check.content_sha256) {
        throw new Error("candidate changed");
      }
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Candidate content changed during commit");
    }
    const tag = extractTag(content);
    const plan = check.role === "ralph"
      ? prepareRalphSubmission({ projectDir: root, tag, external: true, content })
      : prepareLisaSubmission({ projectDir: root, tag, external: true, content });
    const input = { project: root, leaseId, requestId, candidateId,
      expectedGeneration, expectedBindingGeneration, plan };
    const precheck = checkAndPersistBlockedSubmission(input, content, gateRunner);
    if (precheck.rejected) return precheck.rejected;
    if (!precheck.checks) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Submission checks have no durable outcome");
    }
    try {
      persistHostIntent(input);
      applySubmissionPlan(plan);
      advanceGenerationAfterIntent(host, requestId);
      const committed = persistCommittedReceipt(host, requestId, {
        ...precheck.checks, source_confirmation: "human_asserted", source_verification: "unverified",
      });
      archiveCommittedIntent(host, requestId);
      return committed;
    } catch (error) {
      if (entryExists(path.join(host, "intents", `${requestId}.pending`)) ||
          entryExists(path.join(host, "intents", `${requestId}.json`)) ||
          entryExists(path.join(host, "receipts", `${requestId}.pending`)) ||
          entryExists(path.join(host, "receipts", `${requestId}.json`))) {
        throw new HostContractError("NEEDS_RECONCILE", 7,
          "Commit may be partial; inspect the intent, receipt, and business state");
      }
      throw error;
    }
  } finally { release(); }
}
