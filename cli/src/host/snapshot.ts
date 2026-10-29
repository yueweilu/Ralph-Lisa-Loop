import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "../state.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertNoManualRuntime, entryExists, readLease } from "./lease.js";

export interface HostSnapshot {
  schema: 1;
  status: "ok";
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  turn: "ralph" | "lisa";
  round: number;
  step: string;
  host_state: "unclaimed" | "claimed";
  owner_id: string | null;
  state_digest: string;
  generation: null;
  binding_generation: null;
  last_receipt_id: null;
}

const BUSINESS_FILES = [
  "task.md", "work.md", "review.md", "history.md", "last_action.txt",
  "turn.txt", "round.txt", "step.txt",
];

function businessDigest(state: string, turn: string, round: number, step: string): string {
  const hash = crypto.createHash("sha256");
  const readValues = new Map<string, string>();
  for (const name of BUSINESS_FILES) {
    const file = path.join(state, name);
    let bytes: Buffer;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
      bytes = fs.readFileSync(file);
    } catch {
      throw new HostContractError("STATE_INVALID", 7, `Missing, linked, or unreadable ${name}`);
    }
    hash.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
    if (["turn.txt", "round.txt", "step.txt"].includes(name)) {
      readValues.set(name, bytes.toString("utf8").trim());
    }
  }
  if (readValues.get("turn.txt") !== turn || readValues.get("round.txt") !== String(round) ||
      readValues.get("step.txt") !== step) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Turn, round, or step changed during snapshot");
  }
  return hash.digest("hex");
}

function hostOwner(state: string, project: string, sessionId: string): string | null {
  const host = path.join(state, "host");
  if (!entryExists(host)) return null;
  const stat = fs.lstatSync(host);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(host) !== host) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host directory");
  }
  for (const marker of ["claim.lock", "reconcile.json", "lease.json"]) {
    if (entryExists(path.join(host, marker))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Host marker ${marker} requires reconciliation`);
    }
  }
  const intents = path.join(host, "intents");
  if (entryExists(intents)) {
    const intentsStat = fs.lstatSync(intents);
    if (!intentsStat.isDirectory() || intentsStat.isSymbolicLink() || fs.readdirSync(intents).length > 0) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Pending host intents require reconciliation");
    }
  }
  // Later slices must validate these files and replace the null generation fields.
  for (const future of ["generation.json", "binding.json", "receipts", "candidates"]) {
    if (entryExists(path.join(host, future))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Unsupported host metadata: ${future}`);
    }
  }
  if (!entryExists(path.join(host, "lease"))) return null;
  let lease;
  try {
    lease = readLease(host);
  } catch (error) {
    if (error instanceof HostContractError) throw error;
    throw new HostContractError("NEEDS_RECONCILE", 7, "Incomplete host lease");
  }
  if (lease.project_realpath !== project || lease.state_realpath !== state || lease.session_id !== sessionId) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Host lease belongs to another session");
  }
  return lease.owner_id;
}

/** A coherent read across coordinated CLI writers; it never exposes a lease ID. */
export function snapshotProject(project: string): HostSnapshot {
  const projectRealpath = canonicalProject(project);
  const releaseLock = acquireHostLock(path.join(projectRealpath, STATE_DIR));
  try {
    const current = inspectProject(projectRealpath);
    if (!current.initialized || !current.state_realpath) {
      throw new HostContractError("SESSION_NOT_INITIALIZED", 3, "Initialize the RLL session before snapshot");
    }
    if (!current.session_id || current.contract_state !== "identified") {
      throw new HostContractError("ADOPT_REQUIRED", 3, "Legacy sessions require explicit host adopt before snapshot");
    }
    assertNoManualRuntime(current.project_realpath, current.state_realpath);
    const digest = businessDigest(current.state_realpath, current.turn!, current.round!, current.step!);
    const ownerId = hostOwner(current.state_realpath, current.project_realpath, current.session_id);
    return {
      schema: 1,
      status: "ok",
      project_realpath: current.project_realpath,
      state_realpath: current.state_realpath,
      session_id: current.session_id,
      turn: current.turn!,
      round: current.round!,
      step: current.step!,
      host_state: ownerId ? "claimed" : "unclaimed",
      owner_id: ownerId,
      state_digest: digest,
      generation: null,
      binding_generation: null,
      last_receipt_id: null,
    };
  } finally {
    releaseLock();
  }
}
