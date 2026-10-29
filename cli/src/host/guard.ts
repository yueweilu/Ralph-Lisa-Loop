import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir } from "../state.js";

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
  const protectedState = ["lease.json", "lease", "claim.lock", "reconcile.json"]
    .some((name) => entryExists(path.join(hostDir, name)));
  let invalidHostDir = false;
  try {
    const stat = fs.lstatSync(hostDir);
    invalidHostDir = !stat.isDirectory() || stat.isSymbolicLink();
  } catch {
    invalidHostDir = true;
  }

  if (incompleteIdentity || protectedState || invalidHostDir) {
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
  assertHostMutationAllowed(dir);
}
