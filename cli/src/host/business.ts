import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { HostContractError } from "./inspect.js";

export const BUSINESS_FILES = [
  "task.md", "work.md", "review.md", "history.md", "last_action.txt",
  "turn.txt", "round.txt", "step.txt",
];

export function businessDigest(state: string, turn: string, round: number, step: string): string {
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
