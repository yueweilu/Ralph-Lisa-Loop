/** Internal blocked-submission receipt. No business file is written here. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkSubmission, extractLastTag } from "../submission.js";
import { evaluateGate, gateOptionsFromEnv, type GateRunner } from "../gate.js";
import { HostContractError } from "./inspect.js";
import { entryExists } from "./lease.js";
import { prepareHostIntent, type HostIntentInput } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RejectedHostReceipt {
  schema: 1;
  status: "rejected";
  code: "POLICY_BLOCKED" | "GATE_BLOCKED";
  reason: "policy" | "needs_work" | "gate";
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
  policy: { result: "pass" | "warn" | "block"; rules: string[] };
  gate: { result: "not_enabled" | "pass" | "warn" | "block" };
  rejected_at: string;
}

function regularDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid rejected receipt directory");
  }
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function readRejectedReceipt(host: string, requestId: string): RejectedHostReceipt | null {
  if (!UUID.test(requestId)) throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid request ID");
  const dir = path.join(host, "rejections");
  if (!entryExists(dir)) return null;
  regularDirectory(dir);
  const file = path.join(dir, `${requestId.toLowerCase()}.json`);
  if (!entryExists(file)) return null;
  let value: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid rejection file");
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable rejected receipt");
  }
  const r = value as Partial<RejectedHostReceipt> | null;
  if (!r || r.schema !== 1 || r.status !== "rejected" ||
      r.request_id !== requestId.toLowerCase() || !UUID.test(r.candidate_id ?? "") ||
      typeof r.project_realpath !== "string" || typeof r.state_realpath !== "string" ||
      typeof r.session_id !== "string" || !UUID.test(r.lease_id ?? "") ||
      (r.role !== "ralph" && r.role !== "lisa") ||
      !Number.isSafeInteger(r.generation) || (r.generation ?? -1) < 0 ||
      !Number.isSafeInteger(r.binding_generation) || (r.binding_generation ?? 0) < 1 ||
      r.turn !== r.role || !Number.isSafeInteger(r.round) || (r.round ?? 0) < 1 ||
      typeof r.step !== "string" || !r.step || !SHA256.test(r.state_digest ?? "") ||
      !SHA256.test(r.content_sha256 ?? "") ||
      !r.policy || !["pass", "warn", "block"].includes(r.policy.result) ||
      !Array.isArray(r.policy.rules) || !r.policy.rules.every((rule) => typeof rule === "string") ||
      !r.gate || !["not_enabled", "pass", "warn", "block"].includes(r.gate.result) ||
      !((r.reason === "gate" && r.code === "GATE_BLOCKED" && r.gate.result === "block" &&
          r.policy.result !== "block") ||
        ((r.reason === "policy" || r.reason === "needs_work") && r.code === "POLICY_BLOCKED" &&
          r.policy.result === "block" && r.gate.result === "not_enabled")) ||
      typeof r.rejected_at !== "string" || !Number.isFinite(Date.parse(r.rejected_at))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid rejected receipt");
  }
  return r as RejectedHostReceipt;
}

/** Caller holds the host lock. Returns null when checks allow the submission. */
export function persistBlockedSubmission(
  input: HostIntentInput, content: string, gateRunner?: GateRunner
): RejectedHostReceipt | null {
  const projected = prepareHostIntent(input);
  if (crypto.createHash("sha256").update(content, "utf8").digest("hex") !== projected.content_sha256) {
    throw new HostContractError("STALE_CANDIDATE", 5, "Candidate content differs from the submitted bytes");
  }
  const host = path.join(projected.state_realpath, "host");
  const dir = path.join(host, "rejections");
  if (entryExists(dir)) {
    regularDirectory(dir);
    if (fs.readdirSync(dir).some((name) => name !== `${projected.request_id}.json`)) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Other rejected receipt requires review");
    }
  }
  if (entryExists(path.join(dir, `${projected.request_id}.pending`))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Interrupted rejected receipt write");
  }
  const existing = readRejectedReceipt(host, projected.request_id);
  if (existing) {
    if (existing.candidate_id !== projected.candidate_id ||
        existing.project_realpath !== projected.project_realpath ||
        existing.state_realpath !== projected.state_realpath ||
        existing.session_id !== projected.session_id || existing.lease_id !== projected.lease_id ||
        existing.role !== projected.role || existing.generation !== projected.generation_before ||
        existing.binding_generation !== projected.binding_generation ||
        existing.turn !== projected.turn_before || existing.round !== projected.round_before ||
        existing.step !== projected.step_before || existing.state_digest !== projected.state_digest_before ||
        existing.content_sha256 !== projected.content_sha256) {
      throw new HostContractError("DUPLICATE_CONFLICT", 5, "Existing rejection differs from this request");
    }
    return existing;
  }
  const review = fs.readFileSync(path.join(projected.state_realpath, "review.md"), "utf8");
  const submission = checkSubmission(projected.role, content, projected.turn_before, extractLastTag(review));
  if (submission.failure === "wrong_turn" || submission.failure === "invalid_tag") {
    throw new HostContractError("INVALID_SUBMISSION", 5, "Candidate has the wrong turn or invalid tag");
  }
  const policyBlocked = submission.failure === "policy" || submission.failure === "needs_work";
  const options = gateOptionsFromEnv();
  options.cwd = projected.project_realpath;
  const gate = policyBlocked ? { result: "not_enabled" as const } :
    evaluateGate(submission.tag, options, gateRunner);
  if (!policyBlocked && gate.result !== "block") return null;
  const record: RejectedHostReceipt = {
    schema: 1, status: "rejected",
    code: policyBlocked ? "POLICY_BLOCKED" : "GATE_BLOCKED",
    reason: policyBlocked ? submission.failure as "policy" | "needs_work" : "gate",
    request_id: projected.request_id, candidate_id: projected.candidate_id,
    project_realpath: projected.project_realpath, state_realpath: projected.state_realpath,
    session_id: projected.session_id, lease_id: projected.lease_id, role: projected.role,
    generation: projected.generation_before, binding_generation: projected.binding_generation,
    turn: projected.turn_before, round: projected.round_before, step: projected.step_before,
    state_digest: projected.state_digest_before, content_sha256: projected.content_sha256,
    policy: { result: policyBlocked ? "block" : submission.violations.length ? "warn" : "pass",
      rules: submission.violations.map((violation) => violation.rule) },
    gate: { result: gate.result }, rejected_at: new Date().toISOString(),
  };
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
  return record;
}
