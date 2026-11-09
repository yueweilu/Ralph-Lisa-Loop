/** Immutable read side of host task-update events. Existing submission receipts stay unchanged. */
import * as fs from "node:fs";
import * as path from "node:path";
import { HostContractError } from "./inspect.js";
import { entryExists } from "./lease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CHANGE_NAMES = new Set(["task.md", "work.md", "review.md", "history.md", "last_action.txt", "turn.txt",
  "round.txt", "step.txt", "needs_work_count.txt", "deadlock.txt"]);

export interface TaskUpdateChange {
  name: string;
  action: "write" | "delete";
  before_sha256: string | null;
  after_sha256: string | null;
}

export interface TaskUpdateIntent {
  schema: 1;
  event: "task_update";
  status: "prepared";
  request_id: string;
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease_id: string;
  binding_generation: number;
  mode: "supplement" | "switch";
  source_verification: "unverified";
  content_sha256: string;
  generation_before: number;
  task_version_before: number;
  task_version_after: number;
  turn_before: "ralph" | "lisa";
  round_before: number;
  step_before: string;
  turn_after: "ralph" | "lisa";
  round_after: number;
  step_after: string;
  state_digest_before: string;
  state_digest_after: string;
  changes: TaskUpdateChange[];
  created_at: string;
}

export interface TaskUpdateReceipt {
  schema: 1;
  event: "task_update";
  status: "task_updated";
  request_id: string;
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  lease_id: string;
  binding_generation: number;
  mode: "supplement" | "switch";
  source_verification: "unverified";
  content_sha256: string;
  generation_before: number;
  generation_after: number;
  task_version_before: number;
  task_version_after: number;
  turn_after: "ralph" | "lisa";
  round_after: number;
  step_after: string;
  state_digest_after: string;
  committed_at: string;
}

export interface TaskUpdatePair {
  intent: TaskUpdateIntent;
  receipt: TaskUpdateReceipt;
}

function directory(host: string, name: string): string | null {
  const dir = path.join(host, name);
  if (!entryExists(dir)) return null;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir)
    throw new HostContractError("NEEDS_RECONCILE", 7, `Invalid ${name} directory`);
  return dir;
}

function files(host: string, name: string): string[] {
  const dir = directory(host, name);
  if (!dir) return [];
  const names = fs.readdirSync(dir).sort();
  if (names.some((value) => !value.endsWith(".json") ||
      !UUID.test(value.slice(0, -5)) || value !== value.toLowerCase()))
    throw new HostContractError("NEEDS_RECONCILE", 7, `Incomplete ${name} inventory`);
  return names;
}

function record(host: string, folder: string, requestId: string): Record<string, unknown> | null {
  if (!UUID.test(requestId)) throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid task-update request ID");
  const dir = directory(host, folder);
  if (!dir) return null;
  const file = path.join(dir, `${requestId.toLowerCase()}.json`);
  if (!entryExists(file)) return null;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid file");
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid record");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, `Invalid ${folder} task-update record`);
  }
}

export function readTaskUpdateIntent(host: string, requestId: string,
  archived = false): TaskUpdateIntent | null {
  const value = record(host, archived ? "task-update-archived" : "task-update-intents", requestId);
  if (!value) return null;
  const changes = value.changes as TaskUpdateChange[] | null;
  if (value.schema !== 1 || value.event !== "task_update" || value.status !== "prepared" ||
      value.request_id !== requestId.toLowerCase() ||
      typeof value.project_realpath !== "string" || typeof value.state_realpath !== "string" ||
      typeof value.session_id !== "string" || !UUID.test(value.lease_id as string) ||
      !Number.isSafeInteger(value.binding_generation) || (value.binding_generation as number) < 1 ||
      (value.mode !== "supplement" && value.mode !== "switch") ||
      value.source_verification !== "unverified" || !SHA256.test(value.content_sha256 as string) ||
      !Number.isSafeInteger(value.generation_before) || (value.generation_before as number) < 0 ||
      !Number.isSafeInteger(value.task_version_before) || (value.task_version_before as number) < 1 ||
      value.task_version_after !== (value.task_version_before as number) + 1 ||
      (value.turn_before !== "ralph" && value.turn_before !== "lisa") ||
      !Number.isSafeInteger(value.round_before) || (value.round_before as number) < 1 ||
      typeof value.step_before !== "string" || !value.step_before ||
      (value.turn_after !== "ralph" && value.turn_after !== "lisa") ||
      !Number.isSafeInteger(value.round_after) || (value.round_after as number) < 1 ||
      typeof value.step_after !== "string" || !value.step_after ||
      (value.mode === "supplement" && (value.turn_after !== value.turn_before ||
        value.round_after !== value.round_before || value.step_after !== value.step_before)) ||
      (value.mode === "switch" && (value.turn_after !== "ralph" ||
        value.round_after !== 1 || value.step_after !== "planning")) ||
      !SHA256.test(value.state_digest_before as string) ||
      !SHA256.test(value.state_digest_after as string) ||
      !Array.isArray(changes) || changes.length < 3 ||
      new Set(changes.map((change) => change?.name)).size !== changes.length ||
      !["task.md", "history.md", "last_action.txt"].every((name) =>
        changes.some((change) => change.name === name && change.action === "write")) ||
      !changes.every((change) => change && CHANGE_NAMES.has(change.name) &&
        (change.action === "write" || (change.action === "delete" && change.name === "deadlock.txt")) &&
        (change.before_sha256 === null || SHA256.test(change.before_sha256)) &&
        (change.action === "write" ? SHA256.test(change.after_sha256 ?? "") : change.after_sha256 === null)) ||
      typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at)))
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid task-update intent");
  return value as unknown as TaskUpdateIntent;
}

export function readTaskUpdateReceipt(host: string, requestId: string): TaskUpdateReceipt | null {
  const value = record(host, "task-update-receipts", requestId);
  if (!value) return null;
  if (value.schema !== 1 || value.event !== "task_update" || value.status !== "task_updated" ||
      value.request_id !== requestId.toLowerCase() ||
      typeof value.project_realpath !== "string" || typeof value.state_realpath !== "string" ||
      typeof value.session_id !== "string" || !UUID.test(value.lease_id as string) ||
      !Number.isSafeInteger(value.binding_generation) || (value.binding_generation as number) < 1 ||
      (value.mode !== "supplement" && value.mode !== "switch") ||
      value.source_verification !== "unverified" || !SHA256.test(value.content_sha256 as string) ||
      !Number.isSafeInteger(value.generation_before) || (value.generation_before as number) < 0 ||
      value.generation_after !== (value.generation_before as number) + 1 ||
      !Number.isSafeInteger(value.task_version_before) || (value.task_version_before as number) < 1 ||
      value.task_version_after !== (value.task_version_before as number) + 1 ||
      (value.turn_after !== "ralph" && value.turn_after !== "lisa") ||
      !Number.isSafeInteger(value.round_after) || (value.round_after as number) < 1 ||
      typeof value.step_after !== "string" || !value.step_after ||
      !SHA256.test(value.state_digest_after as string) ||
      typeof value.committed_at !== "string" || !Number.isFinite(Date.parse(value.committed_at)))
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid task-update receipt");
  return value as unknown as TaskUpdateReceipt;
}

/** A pending intent or unmatched receipt blocks all later host transitions. */
export function taskUpdatePairs(host: string, project: string, state: string,
  sessionId: string): TaskUpdatePair[] {
  if (files(host, "task-update-intents").length > 0)
    throw new HostContractError("NEEDS_RECONCILE", 7, "Pending task-update intent requires reconciliation");
  const receiptNames = files(host, "task-update-receipts");
  const archivedNames = files(host, "task-update-archived");
  if (JSON.stringify(receiptNames) !== JSON.stringify(archivedNames))
    throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update receipt inventory is incomplete");
  return receiptNames.map((name) => {
    const id = name.slice(0, -5);
    const receipt = readTaskUpdateReceipt(host, id);
    const intent = readTaskUpdateIntent(host, id, true);
    if (!receipt || !intent || intent.project_realpath !== project ||
        intent.state_realpath !== state || intent.session_id !== sessionId ||
        receipt.project_realpath !== project || receipt.state_realpath !== state ||
        receipt.session_id !== sessionId || receipt.lease_id !== intent.lease_id ||
        receipt.binding_generation !== intent.binding_generation || receipt.mode !== intent.mode ||
        receipt.source_verification !== intent.source_verification ||
        receipt.content_sha256 !== intent.content_sha256 ||
        receipt.generation_before !== intent.generation_before ||
        receipt.task_version_before !== intent.task_version_before ||
        receipt.task_version_after !== intent.task_version_after ||
        receipt.turn_after !== intent.turn_after || receipt.round_after !== intent.round_after ||
        receipt.step_after !== intent.step_after ||
        receipt.state_digest_after !== intent.state_digest_after)
      throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update receipt differs from its intent");
    return { intent, receipt };
  });
}
