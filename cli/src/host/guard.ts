import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { stateDir } from "../state.js";

let releaseCurrentLock: (() => void) | null = null;

/** Serialize CLI mutations with host claim, including init which recreates .dual-agent. */
export function acquireSessionCommandLock(statePath: string): () => void {
  const projectPath = path.dirname(path.resolve(statePath));
  // Preserve init's existing "directory does not exist" error before any write.
  if (!fs.existsSync(projectPath)) return () => {};
  const projectDir = fs.realpathSync.native(projectPath);
  const lockDir = path.join(projectDir, ".rll-host-command-lock");
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error("HOST_BUSY: another RLL command is changing this project");
    }
    throw error;
  }

  const inode = fs.lstatSync(lockDir).ino;
  const nonce = crypto.randomUUID();
  const ownerPath = path.join(lockDir, "owner.json");
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, nonce, started_at: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (fs.lstatSync(lockDir).ino !== inode) return;
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { nonce?: string };
      if (owner.nonce !== nonce) return;
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // A missing or changed lock must never be deleted by this process.
    }
  };
}

/** Long-lived terminal attachment cannot retain the short mutation lock. */
export function releaseSessionCommandLock(): void {
  releaseCurrentLock?.();
  releaseCurrentLock = null;
}

function entryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // A mutation must not proceed when ownership cannot be inspected.
    return true;
  }
}

/** Fail before the first side effect of a traditional CLI mutation. */
export function assertHostMutationAllowed(statePath: string): void {
  const dir = path.resolve(statePath);
  const hostDir = path.join(dir, "host");
  if (!entryExists(hostDir)) return;

  const incompleteIdentity = !entryExists(path.join(dir, "session.json"));
  const protectedState = ["lease.json", "lease", "claim.lock", "reconcile.json", "binding.pending", "adoption.pending"]
    .some((name) => entryExists(path.join(hostDir, name)));
  let adoptionPending = false;
  const adoptionPath = path.join(hostDir, "adoption.json");
  if (entryExists(adoptionPath)) {
    try {
      const stat = fs.lstatSync(adoptionPath);
      const record = JSON.parse(fs.readFileSync(adoptionPath, "utf8")) as { schema?: number; kind?: string; status?: string };
      adoptionPending = !stat.isFile() || stat.isSymbolicLink() ||
        record.schema !== 1 || record.kind !== "legacy_adoption" || record.status !== "confirmed";
    } catch {
      adoptionPending = true;
    }
  }
  let invalidHostDir = false;
  try {
    const stat = fs.lstatSync(hostDir);
    invalidHostDir = !stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    invalidHostDir = true;
  }

  if (incompleteIdentity || protectedState || adoptionPending || invalidHostDir) {
    console.error("Error: This RLL session is controlled by a host or needs reconciliation.");
    console.error("Stop or release the host and resolve its state before changing this session.");
    process.exit(4);
  }
}

const MUTATING_COMMANDS = new Set([
  "init", "uninit", "submit-ralph", "submit-lisa", "step", "next-step",
  "archive", "clean", "start", "auto", "scope-update", "update-task",
  "force-turn", "remote", "add-context", "stop", "emergency-msg", "smoke-test",
]);

/** The CLI dispatch also guards commands that do not share a single write helper. */
export function guardCliMutation(command: string, args: string[]): void {
  if (command === "subtask" && args[0] !== "add" && args[0] !== "done") return;
  if (command !== "subtask" && !MUTATING_COMMANDS.has(command)) return;

  let dir: string;
  if (command === "init") {
    const projectArg = args.filter((arg) => arg !== "--minimal")[0];
    dir = stateDir(path.resolve(projectArg || process.cwd()));
  } else if (["start", "auto", "stop", "uninit"].includes(command)) {
    dir = stateDir(process.cwd());
  } else {
    dir = stateDir();
  }
  try {
    releaseCurrentLock = acquireSessionCommandLock(dir);
    process.once("exit", releaseSessionCommandLock);
    assertHostMutationAllowed(dir);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "Unable to acquire session command lock"}`);
    process.exit(4);
  }
}
