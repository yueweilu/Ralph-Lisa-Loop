import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "../state.js";
import { writeSessionIdentity } from "./session.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertNoManualRuntime, entryExists } from "./lease.js";
import { BUSINESS_FILES, businessDigest } from "./business.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

interface AdoptionRecord {
  schema: 1;
  kind: "legacy_adoption";
  status: "pending_review" | "confirmed";
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  backup_id: string;
  state_digest: string;
  turn: "ralph" | "lisa";
  round: number;
  step: string;
  file_sha256: Record<string, string>;
  baseline_generation: 0;
  adopted_at: string;
  confirmed_at?: string;
}

function writeExclusiveJson(file: string, value: object): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function replaceJson(file: string, temp: string, value: object): void {
  writeExclusiveJson(temp, value);
  fs.renameSync(temp, file);
}

function regularBytes(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new HostContractError("STATE_INVALID", 7, `Expected a regular file: ${path.basename(file)}`);
  }
  return fs.readFileSync(file);
}

function fileHash(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readAdoption(host: string, project: string, state: string, sessionId: string): AdoptionRecord {
  let value: unknown;
  try {
    value = JSON.parse(regularBytes(path.join(host, "adoption.json")).toString("utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Missing or unreadable adoption record");
  }
  if (!value || typeof value !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid adoption record");
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || record.kind !== "legacy_adoption" ||
      (record.status !== "pending_review" && record.status !== "confirmed") ||
      record.project_realpath !== project || record.state_realpath !== state || record.session_id !== sessionId ||
      typeof record.backup_id !== "string" || !UUID.test(record.backup_id) ||
      typeof record.state_digest !== "string" || !SHA256.test(record.state_digest) ||
      (record.turn !== "ralph" && record.turn !== "lisa") ||
      !Number.isSafeInteger(record.round) || (record.round as number) < 1 ||
      typeof record.step !== "string" || !record.step || record.baseline_generation !== 0 ||
      !record.file_sha256 || typeof record.file_sha256 !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid adoption record");
  }
  const hashes = record.file_sha256 as Record<string, unknown>;
  if (BUSINESS_FILES.some((name) => typeof hashes[name] !== "string" || !SHA256.test(hashes[name] as string)) ||
      Object.entries(hashes).some(([name, hash]) =>
        ![...BUSINESS_FILES, ".project_root"].includes(name) || typeof hash !== "string" || !SHA256.test(hash))) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid adoption backup manifest");
  }
  return record as unknown as AdoptionRecord;
}

function verifyBackup(host: string, record: AdoptionRecord): void {
  const parent = path.join(host, "adoption-backups");
  const dir = path.join(parent, record.backup_id);
  try {
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync.native(parent) !== parent) {
      throw new Error("invalid backup root");
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) {
      throw new Error("invalid backup directory");
    }
    for (const [name, expected] of Object.entries(record.file_sha256)) {
      if (fileHash(regularBytes(path.join(dir, name))) !== expected) {
        throw new Error(`backup digest changed: ${name}`);
      }
    }
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Adoption backup is missing or changed");
  }
}

function verifyMarker(host: string, backupId: string): void {
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(regularBytes(path.join(host, "reconcile.json")).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Adoption review marker is missing or unreadable");
  }
  if (marker.schema !== 1 || marker.kind !== "legacy_adoption" ||
      marker.status !== "pending_review" || marker.backup_id !== backupId) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Adoption review marker does not match the backup");
  }
}

/** Back up a legacy session, then freeze it until its old turn is reviewed. */
export function adoptLegacy(project: string): object {
  const root = canonicalProject(project);
  const releaseLock = acquireHostLock(path.join(root, STATE_DIR));
  try {
    const current = inspectProject(root);
    if (!current.initialized || !current.state_realpath) {
      throw new HostContractError("SESSION_NOT_INITIALIZED", 3, "Only an existing legacy session can be adopted");
    }
    if (current.contract_state !== "legacy") {
      throw new HostContractError("ALREADY_IDENTIFIED", 5, "Session already has a host identity");
    }
    assertNoManualRuntime(root, current.state_realpath);
    const state = current.state_realpath;
    const digest = businessDigest(state, current.turn!, current.round!, current.step!);
    const host = path.join(state, "host");
    try {
      fs.mkdirSync(host, { mode: 0o700 });
    } catch {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Host metadata already exists in the legacy session");
    }
    const backupId = crypto.randomUUID();
    writeExclusiveJson(path.join(host, "reconcile.json"), {
      schema: 1, kind: "legacy_adoption", status: "adopting", backup_id: backupId,
    });
    const backups = path.join(host, "adoption-backups");
    fs.mkdirSync(backups, { mode: 0o700 });
    const backup = path.join(backups, backupId);
    fs.mkdirSync(backup, { mode: 0o700 });
    const hashes: Record<string, string> = {};
    const names = [...BUSINESS_FILES];
    if (entryExists(path.join(state, ".project_root"))) names.push(".project_root");
    for (const name of names) {
      const bytes = regularBytes(path.join(state, name));
      hashes[name] = fileHash(bytes);
      const fd = fs.openSync(path.join(backup, name), "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const [name, expected] of Object.entries(hashes)) {
      if (fileHash(regularBytes(path.join(state, name))) !== expected ||
          fileHash(regularBytes(path.join(backup, name))) !== expected) {
        throw new HostContractError("NEEDS_RECONCILE", 7, `Legacy file changed during adoption: ${name}`);
      }
    }
    if (businessDigest(backup, current.turn!, current.round!, current.step!) !== digest ||
        businessDigest(state, current.turn!, current.round!, current.step!) !== digest) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Legacy state changed during adoption; review its backup");
    }
    const sessionId = writeSessionIdentity(root, state);
    const record: AdoptionRecord = {
      schema: 1, kind: "legacy_adoption", status: "pending_review",
      project_realpath: root, state_realpath: state, session_id: sessionId,
      backup_id: backupId, state_digest: digest,
      turn: current.turn!, round: current.round!, step: current.step!,
      file_sha256: hashes, baseline_generation: 0, adopted_at: new Date().toISOString(),
    };
    writeExclusiveJson(path.join(host, "adoption.json"), record);
    replaceJson(path.join(host, "reconcile.json"), path.join(host, "reconcile.next"), {
      schema: 1, kind: "legacy_adoption", status: "pending_review", backup_id: backupId,
    });
    return {
      schema: 1, status: "pending_review", session_id: sessionId, backup_id: backupId,
      backup_relative_path: path.join(STATE_DIR, "host", "adoption-backups", backupId),
      state_digest: digest, turn: current.turn, round: current.round, replay: "blocked",
    };
  } finally {
    releaseLock();
  }
}

/** Explicitly accept the old turn as historical; never resend it automatically. */
export function confirmAdoption(project: string, backupId: string, decision: string): object {
  if (!UUID.test(backupId) || decision !== "no-replay") {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "--backup-id must be a UUID and --decision must be no-replay");
  }
  const root = canonicalProject(project);
  const releaseLock = acquireHostLock(path.join(root, STATE_DIR));
  try {
    const current = inspectProject(root);
    if (!current.state_realpath || !current.session_id) {
      throw new HostContractError("ADOPT_REQUIRED", 3, "No identified legacy adoption to confirm");
    }
    const host = path.join(current.state_realpath, "host");
    const record = readAdoption(host, root, current.state_realpath, current.session_id);
    if (record.backup_id !== backupId) {
      throw new HostContractError("ADOPTION_MISMATCH", 4, "Backup ID does not match this adoption");
    }
    if (record.status === "confirmed" && !entryExists(path.join(host, "reconcile.json"))) {
      return { schema: 1, status: "confirmed", session_id: record.session_id, backup_id: backupId, replay: "not_replayed" };
    }
    assertNoManualRuntime(root, current.state_realpath);
    for (const name of ["lease", "lease.json", "claim.lock", "binding.json", "binding.pending", "adoption.pending"]) {
      if (entryExists(path.join(host, name))) {
        throw new HostContractError("NEEDS_RECONCILE", 7, `Unexpected host state during adoption review: ${name}`);
      }
    }
    verifyMarker(host, backupId);
    verifyBackup(host, record);
    if (businessDigest(current.state_realpath, current.turn!, current.round!, current.step!) !== record.state_digest ||
        current.turn !== record.turn || current.round !== record.round || current.step !== record.step) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Business state changed after adoption; review before continuing");
    }
    if (record.status === "pending_review") {
      replaceJson(path.join(host, "adoption.json"), path.join(host, "adoption.pending"), {
        ...record, status: "confirmed", confirmed_at: new Date().toISOString(),
      });
    }
    fs.unlinkSync(path.join(host, "reconcile.json"));
    return { schema: 1, status: "confirmed", session_id: record.session_id, backup_id: backupId, replay: "not_replayed" };
  } finally {
    releaseLock();
  }
}
