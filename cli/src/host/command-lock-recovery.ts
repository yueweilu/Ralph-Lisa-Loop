/** Explicit retirement of a short command lock left by a dead process. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalProject, HostContractError } from "./inspect.js";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CommandLockCheck {
  schema: 1;
  status: "absent" | "active" | "stale";
  project_realpath: string;
  pid?: number;
  nonce?: string;
  evidence_sha256?: string;
}

function readLock(project: string): { lock: string; pid: number; nonce: string; evidence: string } | null {
  const lock = path.join(project, ".rll-host-command-lock");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HostContractError("HOST_IO_ERROR", 8, "Cannot inspect command lock");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(lock) !== lock ||
      fs.readdirSync(lock).join("\0") !== "owner.json") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Command lock is incomplete or contains unexpected files");
  }
  const file = path.join(lock, "owner.json");
  try {
    const ownerStat = fs.lstatSync(file);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw new Error("invalid owner file");
    const bytes = fs.readFileSync(file);
    const owner = JSON.parse(bytes.toString("utf8")) as { pid?: number; nonce?: string; started_at?: string };
    if (!Number.isSafeInteger(owner.pid) || owner.pid! < 1 ||
        typeof owner.nonce !== "string" || !UUID.test(owner.nonce) ||
        typeof owner.started_at !== "string" || !Number.isFinite(Date.parse(owner.started_at))) {
      throw new Error("invalid owner record");
    }
    const evidence = crypto.createHash("sha256").update(String(stat.dev)).update(":")
      .update(String(stat.ino)).update(":").update(bytes).digest("hex");
    return { lock, pid: owner.pid!, nonce: owner.nonce, evidence };
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Command lock owner record needs manual review");
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // Permission failures and unknown errors cannot prove the owner stopped.
  }
}

export function commandLockCheck(project: string): CommandLockCheck {
  const root = canonicalProject(project);
  const owner = readLock(root);
  if (!owner) return { schema: 1, status: "absent", project_realpath: root };
  return { schema: 1, status: alive(owner.pid) ? "active" : "stale",
    project_realpath: root, pid: owner.pid, nonce: owner.nonce,
    evidence_sha256: owner.evidence };
}

/** No replay or business writes; preserve the old lock directory for audit. */
export function retireCommandLock(project: string, expectedEvidence: string, decision: string) {
  if (!SHA256.test(expectedEvidence) || decision !== "verified-stopped-no-replay") {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Expected lock evidence and verified-stopped-no-replay decision are required");
  }
  const root = canonicalProject(project);
  const before = readLock(root);
  if (!before || before.evidence !== expectedEvidence) {
    throw new HostContractError("STALE_LOCK", 5, "Command lock evidence changed or disappeared");
  }
  if (alive(before.pid)) {
    throw new HostContractError("HOST_BUSY", 4, "Command lock owner may still be running");
  }
  const retired = path.join(root, `.rll-host-command-lock-retired-${crypto.randomUUID()}`);
  try { fs.renameSync(before.lock, retired); }
  catch {
    throw new HostContractError("STALE_LOCK", 5, "Command lock changed during retirement");
  }
  let after: string;
  try { after = readRetired(retired); }
  catch {
    throw new HostContractError("NEEDS_RECONCILE", 7,
      "Retired command lock cannot be verified; inspect its preserved directory");
  }
  if (after !== expectedEvidence) {
    // A changed directory remains preserved; never erase it or assume the operation is safe.
    throw new HostContractError("NEEDS_RECONCILE", 7, "Retired command lock differs from reviewed evidence");
  }
  return { schema: 1 as const, status: "retired" as const, project_realpath: root,
    pid: before.pid, nonce: before.nonce, evidence_sha256: before.evidence,
    retired_relative_path: path.basename(retired), decision };
}

function readRetired(dir: string): string {
  const stat = fs.lstatSync(dir);
  const bytes = fs.readFileSync(path.join(dir, "owner.json"));
  return crypto.createHash("sha256").update(String(stat.dev)).update(":")
    .update(String(stat.ino)).update(":").update(bytes).digest("hex");
}
