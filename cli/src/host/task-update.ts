/** Host-managed task change with a durable intent and an immutable transition receipt. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUSINESS_FILES, businessDigest } from "./business.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, entryExists } from "./lease.js";
import { readGeneration } from "./generation.js";
import { committedReceiptLedger } from "./receipt-store.js";
import { checkTaskUpdateLocked, readTaskUpdateText, type TaskUpdateMode,
  type TaskUpdatePreflight } from "./task-update-check.js";
import { auditTaskUpdateIntent, readTaskUpdateIntent, readTaskUpdateReceipt, type TaskUpdateChange,
  type TaskUpdateIntent, type TaskUpdateReceipt } from "./task-update-record.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type PlannedChange = TaskUpdateChange & { after_bytes?: Buffer };
const sha = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureDirectory(host: string, name: string): string {
  const dir = path.join(host, name);
  if (!entryExists(dir)) {
    fs.mkdirSync(dir, { mode: 0o700 });
    syncDirectory(host);
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir)
    throw new HostContractError("NEEDS_RECONCILE", 7, `Invalid ${name} directory`);
  return dir;
}

function atomicJson(dir: string, name: string, value: object): void {
  const pending = path.join(dir, `${name}.pending`);
  const final = path.join(dir, `${name}.json`);
  const fd = fs.openSync(pending, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(pending, final);
  syncDirectory(dir);
}

function currentFile(state: string, name: string): Buffer | null {
  const file = path.join(state, name);
  if (!entryExists(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new HostContractError("STATE_INVALID", 7, `Invalid task-update file ${name}`);
  return fs.readFileSync(file);
}

function plan(preflight: TaskUpdatePreflight, text: string): PlannedChange[] {
  const state = path.join(preflight.project_realpath, ".dual-agent");
  const now = new Date().toISOString();
  const marker = preflight.mode === "switch"
    ? "New task; earlier task requirements are superseded"
    : "Supplement to the current task";
  const entry = `\n---\nTask version: ${preflight.task_version_after}\nMode: ${preflight.mode}\nUpdated: ${now}\n${marker}\n\n${text.trim()}\n`;
  const changes: PlannedChange[] = [];
  const add = (name: string, content: Buffer | string): void => {
    const before = currentFile(state, name);
    const after = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    changes.push({ name, action: "write", before_sha256: before ? sha(before) : null,
      after_sha256: sha(after), after_bytes: after });
  };
  const append = (name: string, content: string): void =>
    add(name, Buffer.concat([currentFile(state, name) ?? Buffer.alloc(0), Buffer.from(content)]));
  append("task.md", entry);
  append("history.md", `\n---\n\n## [System] [SCOPE] Round ${preflight.round_before} | Step: ${preflight.step_before}\n` +
    `**Time**: ${now}\n**Summary**: Task ${preflight.mode} to version ${preflight.task_version_after}\n\n${text.trim()}\n\n`);
  add("last_action.txt", `[SCOPE] Task ${preflight.mode} to version ${preflight.task_version_after} (by System, ${now})`);
  if (preflight.mode === "switch") {
    const reset = `\n\n## [TASK_SWITCH] Round 1 | Step: planning\n` +
      `**Time**: ${now}\n**Summary**: Task version ${preflight.task_version_after} begins.\n`;
    append("work.md", reset);
    append("review.md", reset);
    add("turn.txt", "ralph");
    add("round.txt", "1");
    add("step.txt", "planning");
  }
  add("needs_work_count.txt", "0");
  const deadlock = currentFile(state, "deadlock.txt");
  if (deadlock) changes.push({ name: "deadlock.txt", action: "delete",
    before_sha256: sha(deadlock), after_sha256: null });
  return changes;
}

function projectedDigest(state: string, changes: PlannedChange[]): string {
  const replacements = new Map(changes.filter((change) => change.action === "write")
    .map((change) => [change.name, change.after_bytes!]));
  const hash = crypto.createHash("sha256");
  for (const name of BUSINESS_FILES) {
    const bytes = replacements.get(name) ?? currentFile(state, name);
    if (!bytes) throw new HostContractError("STATE_INVALID", 7, `Missing business file ${name}`);
    hash.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

function apply(state: string, changes: PlannedChange[]): void {
  for (const change of changes) {
    const file = path.join(state, change.name);
    const before = currentFile(state, change.name);
    if ((before ? sha(before) : null) !== change.before_sha256)
      throw new HostContractError("NEEDS_RECONCILE", 7, `Task-update file changed: ${change.name}`);
    if (change.action === "delete") fs.unlinkSync(file);
    else {
      const fd = fs.openSync(file, "w", 0o600);
      try { fs.writeFileSync(fd, change.after_bytes!); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    const after = currentFile(state, change.name);
    if ((after ? sha(after) : null) !== change.after_sha256)
      throw new HostContractError("NEEDS_RECONCILE", 7, `Task-update write differed: ${change.name}`);
  }
  syncDirectory(state);
}

function sameRequest(receipt: TaskUpdateReceipt, leaseId: string, requestId: string,
  generation: number, bindingGeneration: number, mode: TaskUpdateMode, hash: string): boolean {
  return receipt.request_id === requestId && receipt.lease_id === leaseId &&
    receipt.generation_before === generation && receipt.binding_generation === bindingGeneration &&
    receipt.mode === mode && receipt.content_sha256 === hash;
}

/** Writer is called only by the lease-owning coordinator after cursor delivery checks. */
export function updateHostTask(project: string, leaseId: string, requestId: string,
  expectedGeneration: number, expectedBindingGeneration: number, expectedDigest: string,
  mode: TaskUpdateMode, file: string, contentSha256: string): TaskUpdateReceipt {
  if (!UUID.test(leaseId) || !UUID.test(requestId))
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid task-update lease or request ID");
  leaseId = leaseId.toLowerCase();
  requestId = requestId.toLowerCase();
  const root = canonicalProject(project);
  const initial = inspectProject(root);
  if (!initial.initialized || !initial.state_realpath || !initial.session_id)
    throw new HostContractError("ADOPT_REQUIRED", 3, "An identified session is required for task updates");
  const release = acquireHostLock(initial.state_realpath);
  try {
    const state = initial.state_realpath;
    const host = path.join(state, "host");
    const stored = readTaskUpdateReceipt(host, requestId);
    if (stored) {
      if (!sameRequest(stored, leaseId, requestId, expectedGeneration,
          expectedBindingGeneration, mode, contentSha256))
        throw new HostContractError("DUPLICATE_CONFLICT", 5, "Task-update request ID was reused");
      const active = readTaskUpdateIntent(host, requestId);
      const archived = readTaskUpdateIntent(host, requestId, true);
      if (!!active === !!archived)
        throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update intent location is uncertain");
      const intent = active ?? archived!;
      if (intent.project_realpath !== root || intent.session_id !== initial.session_id ||
          intent.state_realpath !== state || intent.state_digest_before !== expectedDigest)
        throw new HostContractError("DUPLICATE_CONFLICT", 5, "Task-update request belongs to another state");
      if (active && auditTaskUpdateIntent(intent).status !== "applied")
        throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update business writes need review");
      const generation = readGeneration(host, root, state, initial.session_id);
      if (!generation || generation.generation < stored.generation_after)
        throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update generation needs review");
      if (active) {
        const dir = ensureDirectory(host, "task-update-archived");
        fs.renameSync(path.join(host, "task-update-intents", `${requestId}.json`),
          path.join(dir, `${requestId}.json`));
        syncDirectory(dir);
      }
      committedReceiptLedger(host, root, state, initial.session_id, generation);
      return stored;
    }
    if (readTaskUpdateIntent(host, requestId) || readTaskUpdateIntent(host, requestId, true))
      throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update intent exists without a verified receipt");
    const checked = checkTaskUpdateLocked(root, leaseId, requestId, expectedGeneration,
      expectedBindingGeneration, expectedDigest, mode, file, contentSha256);
    const text = readTaskUpdateText(root, file, contentSha256);
    const changes = plan(checked, text);
    const afterDigest = projectedDigest(state, changes);
    const nextTurn = checked.target_role;
    const nextRound = mode === "switch" ? 1 : checked.round_before;
    const nextStep = mode === "switch" ? "planning" : checked.step_before;
    const intent: TaskUpdateIntent = {
      schema: 1, event: "task_update", status: "prepared", request_id: requestId,
      project_realpath: root, state_realpath: state, session_id: checked.session_id,
      lease_id: leaseId, binding_generation: checked.binding_generation,
      mode, source_verification: "unverified", content_sha256: contentSha256,
      generation_before: checked.generation_before,
      task_version_before: checked.task_version_before, task_version_after: checked.task_version_after,
      turn_before: checked.turn_before, round_before: checked.round_before, step_before: checked.step_before,
      turn_after: nextTurn, round_after: nextRound, step_after: nextStep,
      state_digest_before: checked.state_digest_before, state_digest_after: afterDigest,
      changes: changes.map(({ name, action, before_sha256, after_sha256 }) =>
        ({ name, action, before_sha256, after_sha256 })), created_at: new Date().toISOString(),
    };
    const intents = ensureDirectory(host, "task-update-intents");
    atomicJson(intents, requestId, intent);
    try {
      apply(state, changes);
      if (businessDigest(state, nextTurn, nextRound, nextStep) !== afterDigest ||
          auditTaskUpdateIntent(intent).status !== "applied")
        throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update write differs from intent");
      const prior = readGeneration(host, root, state, initial.session_id);
      if (!prior || prior.generation !== expectedGeneration ||
          prior.state_digest !== checked.state_digest_before)
        throw new HostContractError("NEEDS_RECONCILE", 7, "Task-update generation baseline changed");
      const next = { ...prior, generation: prior.generation + 1, state_digest: afterDigest,
        turn: nextTurn, round: nextRound, step: nextStep,
        last_receipt_id: requestId, updated_at: new Date().toISOString() };
      atomicJson(host, "generation", next);
      const receipt: TaskUpdateReceipt = {
        schema: 1, event: "task_update", status: "task_updated", request_id: requestId,
        project_realpath: root, state_realpath: state, session_id: checked.session_id,
        lease_id: leaseId, binding_generation: checked.binding_generation,
        mode, source_verification: "unverified", content_sha256: contentSha256,
        generation_before: expectedGeneration, generation_after: expectedGeneration + 1,
        task_version_before: checked.task_version_before, task_version_after: checked.task_version_after,
        turn_after: nextTurn, round_after: nextRound, step_after: nextStep,
        state_digest_after: afterDigest, committed_at: new Date().toISOString(),
      };
      const receipts = ensureDirectory(host, "task-update-receipts");
      atomicJson(receipts, requestId, receipt);
      const archived = ensureDirectory(host, "task-update-archived");
      fs.renameSync(path.join(intents, `${requestId}.json`), path.join(archived, `${requestId}.json`));
      syncDirectory(intents);
      syncDirectory(archived);
      committedReceiptLedger(host, root, state, checked.session_id,
        readGeneration(host, root, state, checked.session_id));
      return receipt;
    } catch {
      throw new HostContractError("NEEDS_RECONCILE", 7,
        "Task update may be partial; inspect intent, business state, generation, and receipt");
    }
  } finally { release(); }
}
