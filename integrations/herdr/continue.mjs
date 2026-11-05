import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const SHA256 = /^[0-9a-f]{64}$/;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

function visible(value) {
  return String(value).replace(HIDDEN, (character) =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.RL_STATE_DIR;
  return env;
}

function check() {
  const result = spawnSync(process.execPath, [path.join(root, "actions.mjs"),
    "continuation-check"], { encoding: "utf8", env: cleanEnv(), timeout: 90000 });
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch { /* Read failed. */ }
  return { code: result.status, value };
}

function launch(args, write) {
  const child = spawn(process.execPath, [path.join(root, "coordinator.mjs"), ...args],
    { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let confirmed = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (!confirmed) reject(new Error("CONTINUATION_OUTCOME_UNCERTAIN"));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let value;
        try { value = JSON.parse(line); }
        catch { write(visible(line)); continue; }
        write(visible(JSON.stringify(value)));
        if (!confirmed) {
          confirmed = true;
          clearTimeout(timer);
          if (value.status === "continued" && value.replay === "not_replayed")
            resolve(value);
          else reject(new Error(value.code || "CONTINUATION_OUTCOME_UNCERTAIN"));
        }
      }
    });
    child.stderr.on("data", (chunk) => write(visible(chunk.toString())));
    child.on("error", () => {
      if (!confirmed) { clearTimeout(timer); reject(new Error("CONTINUATION_OUTCOME_UNCERTAIN")); }
    });
    child.on("close", () => {
      if (!confirmed) { clearTimeout(timer); reject(new Error("CONTINUATION_OUTCOME_UNCERTAIN")); }
    });
  });
}

export async function reviewContinuation({ ask, write = console.log,
  call = check, run = launch }) {
  const checked = call();
  const value = checked.value;
  if (checked.code !== 0 || value?.status !== "review_required" ||
      !SHA256.test(value.evidence_sha256 ?? "") ||
      !Array.isArray(value.continuation_blockers) || value.continuation_blockers.length)
    throw new Error(value?.code || "CONTINUATION_CHECK_FAILED");
  write(`Project: ${visible(value.project)}`);
  write(`Session: ${visible(value.session_id)}  Generation: ${visible(value.generation)}  Turn: ${visible(value.turn)}`);
  write(`Replacement lease: ${visible(value.lease_id)}  Last receipt: ${visible(value.last_receipt_id ?? "none")}`);
  write(`Evidence SHA-256: ${value.evidence_sha256}`);
  write("Continuing starts heartbeats and watches new receipts. It will not replay a previous prompt.");
  const expected = `CONTINUE ${value.evidence_sha256}`;
  const answer = (await ask(`Type '${expected}' to continue (Enter cancels): `)).trim();
  if (answer !== expected) return { status: "cancelled" };
  const continued = await run(["continue", value.evidence_sha256,
    "reviewed-cursor-no-replay"], write);
  if (continued?.status !== "continued" || continued.project !== value.project ||
      continued.lease_id !== value.lease_id || continued.replay !== "not_replayed")
    throw new Error("CONTINUATION_OUTCOME_UNCERTAIN");
  return { status: "continued", lease_id: continued.lease_id };
}

async function main() {
  if (!process.stdin.isTTY) throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Ralph-Lisa paused rebind continuation / Herdr");
    await reviewContinuation({ ask: (prompt) => input.question(prompt) });
  } finally { input.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
