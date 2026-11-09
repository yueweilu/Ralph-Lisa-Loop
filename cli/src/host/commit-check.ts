/** Read-only formal submission preflight. Source attribution and the write remain separate. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { gateOptionsFromEnv } from "../gate.js";
import { checkSubmission, extractLastTag } from "../submission.js";
import { prepareLisaSubmission, prepareRalphSubmission } from "../submission-write.js";
import { businessDigest } from "./business.js";
import { autoAuthorizationForSeat } from "./auto-authorization.js";
import { candidateInventory } from "./candidate.js";
import { readHumanConfirmation } from "./confirmation.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock } from "./lease.js";
import { readRejectedReceipt } from "./rejection.js";
import { prepareHostIntent } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HostCommitCheck {
  schema: 1;
  status: "awaiting_source_confirmation" | "human_source_asserted" | "auto_source_authorized" | "policy_blocked";
  request_id: string;
  candidate_id: string;
  session_id: string;
  lease_id: string;
  role: "ralph" | "lisa";
  generation_before: number;
  binding_generation: number;
  turn_before: "ralph" | "lisa";
  turn_after: "ralph" | "lisa";
  round_before: number;
  round_after: number;
  step_before: string;
  content_sha256: string;
  state_digest_before: string;
  workspace_id: string;
  pane_id: string;
  agent_target: string;
  source_verification: "unverified";
  human_confirmation: "absent" | "asserted";
  auto_authorization: "absent" | "active";
  auto_authorization_launch_request_id: string | null;
  commit_ready: false;
  policy: { result: "pass" | "warn" | "block"; rules: string[] };
  gate: "not_enabled" | "pending" | "skipped_policy";
}

/** Caller holds the host lock. The result never attests to an Agent's identity. */
export function checkHostCommitLocked(
  project: string, leaseId: string, requestId: string, candidateId: string,
  expectedGeneration: number, expectedBindingGeneration: number
): HostCommitCheck {
  if (!UUID.test(leaseId) || !UUID.test(requestId) || !UUID.test(candidateId) ||
      !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 ||
      !Number.isSafeInteger(expectedBindingGeneration) || expectedBindingGeneration < 1) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid commit-check identifiers or generations");
  }
  const root = canonicalProject(project);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id ||
      initial.contract_state !== "identified") {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for commit-check");
  }
    const current = inspectProject(root);
    if (current.state_realpath !== initial.state_realpath || current.session_id !== initial.session_id) {
      throw new HostContractError("STALE_SESSION", 5, "Session changed while acquiring the host lock");
    }
    const host = path.join(initial.state_realpath, "host");
    const hostStat = fs.lstatSync(host);
    if (!hostStat.isDirectory() || hostStat.isSymbolicLink() || fs.realpathSync.native(host) !== host) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host directory");
    }
    businessDigest(initial.state_realpath, current.turn!, current.round!, current.step!);
    const candidate = candidateInventory(host, root, initial.state_realpath, initial.session_id)
      .candidates.find((item) => item.candidate_id === candidateId.toLowerCase());
    if (!candidate) throw new HostContractError("CANDIDATE_NOT_FOUND", 5, "No candidate for this ID");
    let content: string;
    try {
      const bytes = fs.readFileSync(path.join(host, "candidates", candidate.candidate_id, "content.txt"));
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== candidate.content_sha256) {
        throw new Error("candidate changed");
      }
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Candidate content changed during commit-check");
    }
    const review = fs.readFileSync(path.join(initial.state_realpath, "review.md"), "utf8");
    const check = checkSubmission(candidate.role, content, current.turn!, extractLastTag(review));
    const plan = candidate.role === "ralph"
      ? prepareRalphSubmission({ projectDir: root, tag: check.tag, external: true, content })
      : prepareLisaSubmission({ projectDir: root, tag: check.tag, external: true, content });
    const intent = prepareHostIntent({ project: root, leaseId, requestId, candidateId,
      expectedGeneration, expectedBindingGeneration, plan });
    if (readRejectedReceipt(host, intent.request_id)) {
      throw new HostContractError("DUPLICATE_CONFLICT", 5,
        "Request ID already belongs to a rejected submission");
    }
    if (check.failure === "wrong_turn" || check.failure === "invalid_tag") {
      throw new HostContractError("INVALID_SUBMISSION", 5, "Candidate has the wrong turn or invalid tag");
    }
    const blocked = check.failure === "policy" || check.failure === "needs_work";
    const gateOptions = gateOptionsFromEnv();
    const humanConfirmation = readHumanConfirmation(host, intent.request_id);
    if (humanConfirmation && (humanConfirmation.candidate_id !== intent.candidate_id ||
        humanConfirmation.project_realpath !== root ||
        humanConfirmation.state_realpath !== initial.state_realpath ||
        humanConfirmation.session_id !== intent.session_id ||
        humanConfirmation.lease_id !== intent.lease_id ||
        humanConfirmation.role !== intent.role ||
        humanConfirmation.generation !== intent.generation_before ||
        humanConfirmation.binding_generation !== intent.binding_generation ||
        humanConfirmation.turn !== intent.turn_before ||
        humanConfirmation.round !== intent.round_before ||
        humanConfirmation.step !== intent.step_before ||
        humanConfirmation.state_digest !== intent.state_digest_before ||
        humanConfirmation.content_sha256 !== intent.content_sha256 ||
        humanConfirmation.workspace_id !== candidate.intended_workspace_id ||
        humanConfirmation.pane_id !== candidate.intended_pane_id ||
        humanConfirmation.agent_target !== candidate.intended_agent_target)) {
      throw new HostContractError("DUPLICATE_CONFLICT", 5,
        "Human source assertion belongs to a different candidate or seat");
    }
    const autoAuthorization = autoAuthorizationForSeat(host, root, initial.state_realpath,
      intent.session_id, intent.lease_id, intent.binding_generation,
      candidate.intended_workspace_id, intent.role, candidate.intended_pane_id,
      candidate.intended_agent_target);
    return {
      schema: 1, status: blocked ? "policy_blocked" : humanConfirmation
        ? "human_source_asserted" : autoAuthorization
          ? "auto_source_authorized" : "awaiting_source_confirmation",
      request_id: intent.request_id, candidate_id: intent.candidate_id,
      session_id: intent.session_id, lease_id: intent.lease_id, role: intent.role,
      generation_before: intent.generation_before, binding_generation: intent.binding_generation,
      turn_before: intent.turn_before, turn_after: intent.turn_after,
      round_before: intent.round_before, round_after: intent.round_after,
      step_before: intent.step_before,
      content_sha256: intent.content_sha256,
      state_digest_before: intent.state_digest_before,
      workspace_id: candidate.intended_workspace_id, pane_id: candidate.intended_pane_id,
      agent_target: candidate.intended_agent_target,
      source_verification: "unverified", human_confirmation: humanConfirmation ? "asserted" : "absent",
      auto_authorization: autoAuthorization ? "active" : "absent",
      auto_authorization_launch_request_id: autoAuthorization?.launch_request_id ?? null,
      commit_ready: false,
      policy: { result: blocked ? "block" : check.violations.length ? "warn" : "pass",
        rules: check.violations.map((violation) => violation.rule) },
      gate: blocked ? "skipped_policy" : (check.tag === "CODE" || check.tag === "FIX") && gateOptions.enabled &&
        gateOptions.commands.length > 0 ? "pending" : "not_enabled",
    };
}

/** Read-only public wrapper around the locked preflight. */
export function checkHostCommit(
  project: string, leaseId: string, requestId: string, candidateId: string,
  expectedGeneration: number, expectedBindingGeneration: number
): HostCommitCheck {
  const root = canonicalProject(project);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id ||
      initial.contract_state !== "identified") {
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for commit-check");
  }
  const release = acquireHostLock(initial.state_realpath);
  try {
    return checkHostCommitLocked(root, leaseId, requestId, candidateId,
      expectedGeneration, expectedBindingGeneration);
  } finally { release(); }
}
