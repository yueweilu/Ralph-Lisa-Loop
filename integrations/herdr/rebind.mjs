import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const SHA256 = /^[0-9a-f]{64}$/;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

function visible(value) {
  return String(value).replace(HIDDEN, (character) =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

function invoke(script, args) {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.RL_STATE_DIR;
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 90000,
  });
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch { /* Do not retry a write. */ }
  return { code: result.status, value, error: result.error?.code ?? null };
}

export async function reviewRebind({ ask, write = console.log, call = invoke }) {
  const checked = call("actions.mjs", ["rebind-check"]);
  const value = checked.value;
  if (checked.code !== 0 || value?.status !== "review_required" ||
      !SHA256.test(value.evidence_sha256 ?? "") ||
      !Array.isArray(value.continuation_blockers) || value.continuation_blockers.length)
    throw new Error(value?.code || "REBIND_CHECK_FAILED");
  write(`Project: ${visible(value.project)}`);
  write(`Session: ${visible(value.session_id)}  Generation: ${visible(value.generation)}  Turn: ${visible(value.turn)}`);
  write(`Last receipt: ${visible(value.last_receipt_id ?? "none")}`);
  write(`Old lease: ${visible(value.old_lease_id)}  Recovery: ${visible(value.recovery_id)}`);
  write(`Proposed workspace: ${visible(value.binding_plan.workspace_id)}`);
  for (const role of ["ralph", "lisa"]) {
    const seat = value.binding_plan.seats[role];
    write(`${role}: ${visible(seat.pane_id)} / ${visible(seat.terminal_id)} / native ${visible(seat.native_session_fingerprint_sha256 ?? "unrecorded")}`);
  }
  write(`Evidence SHA-256: ${value.evidence_sha256}`);
  write("Confirm the old coordinator and prompts are stopped. Rebinding will claim a new lease and bind seats, then remain paused. It will not send a prompt.");
  const expected = `REBIND ${value.evidence_sha256}`;
  const answer = (await ask(`Type '${expected}' to claim and bind (Enter cancels): `)).trim();
  if (answer !== expected) return { status: "cancelled" };
  const rebound = call("coordinator.mjs", ["rebind", value.evidence_sha256,
    "verified-seats-no-replay"]);
  if (rebound.code !== 0 || rebound.value?.status !== "rebound_paused" ||
      rebound.value.project !== value.project || rebound.value.replay !== "not_replayed")
    throw new Error(`REBIND_OUTCOME_UNCERTAIN; inspect host snapshot for ${value.project}`);
  write(`Rebound and paused. New lease: ${rebound.value.lease_id}`);
  return { status: "rebound_paused", lease_id: rebound.value.lease_id };
}

async function main() {
  if (!process.stdin.isTTY) throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Ralph-Lisa recovered lease rebind / Herdr");
    await reviewRebind({ ask: (prompt) => input.question(prompt) });
  } finally { input.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
