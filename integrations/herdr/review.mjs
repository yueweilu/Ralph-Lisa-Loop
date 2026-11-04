import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function invoke(argv, args, timeout = 150000) {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.RL_STATE_DIR;
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout,
  });
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch { /* Unknown result; never retry a write. */ }
  return { code: result.status, value, error: result.error?.code ?? null };
}

function cliSettings() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir || !path.isAbsolute(dir)) throw new Error("HERDR_PLUGIN_CONFIG_DIR_REQUIRED");
  const file = path.join(dir, "settings.json");
  if (!fs.existsSync(file)) return ["ralph-lisa"];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("INVALID_SETTINGS");
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const argv = settings?.rll_cli_argv ?? ["ralph-lisa"];
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 4 ||
      !argv.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error("INVALID_SETTINGS");
  }
  return argv;
}

function projectFromStatus() {
  const file = fileURLToPath(new URL("./actions.mjs", import.meta.url));
  const response = invoke([process.execPath, file], ["status"], 30000);
  const value = response.value;
  if (value?.snapshot?.status !== "ok" || !path.isAbsolute(value.project ?? "") ||
      value.snapshot.project_realpath !== fs.realpathSync.native(value.project)) {
    throw new Error(value?.code || "RLL_SNAPSHOT_FAILED");
  }
  return value.snapshot.project_realpath;
}

function host(cli, action, project, tail = []) {
  return invoke(cli, ["host", action, "--project", project, ...tail, "--json"]);
}

/** Interactive human review; no source attestation or automatic retry is inferred from this Pane. */
export async function reviewCandidate({ project, cli, ask, write = console.log, call = host }) {
  const listed = call(cli, "candidates", project);
  if (listed.code !== 0 || listed.value?.status !== "ok" || !Array.isArray(listed.value.candidates))
    throw new Error(listed.value?.code || "CANDIDATE_LIST_FAILED");
  write(`Project: ${project}`);
  write(`Session: ${listed.value.session_id}`);
  for (const candidate of listed.value.candidates) {
    write(`${candidate.candidate_id}  ${candidate.role}  round ${candidate.round}  generation ${candidate.generation}  ${candidate.content_sha256}`);
  }
  if (!listed.value.candidates.length) return { status: "empty" };
  const id = (await ask("Candidate ID to review (Enter cancels): ")).trim().toLowerCase();
  if (!id) return { status: "cancelled" };
  if (!UUID.test(id)) throw new Error("INVALID_CANDIDATE_ID");
  const detail = call(cli, "candidate-show", project, ["--candidate-id", id]);
  if (detail.code !== 0 || detail.value?.status !== "ok" ||
      detail.value.candidate?.candidate_id !== id || typeof detail.value.content !== "string")
    throw new Error(detail.value?.code || "CANDIDATE_READ_FAILED");
  const c = detail.value.candidate;
  if (c.source_verification !== "unverified" || !SHA256.test(c.content_sha256) ||
      c.project_realpath !== project || c.session_id !== listed.value.session_id)
    throw new Error("CANDIDATE_IDENTITY_MISMATCH");
  write(`\nCandidate ${id}\nRole: ${c.role}  Round: ${c.round}  Step: ${c.step}`);
  write(`Session: ${c.session_id}\nLease: ${c.lease_id}\nGeneration: ${c.generation}  Binding: ${c.binding_generation}`);
  write(`Workspace: ${c.intended_workspace_id}\nPane: ${c.intended_pane_id}\nAgent: ${c.intended_agent_target}`);
  write(`SHA-256: ${c.content_sha256}\nSource: unverified`);
  write("----- Candidate body -----");
  write(detail.value.content);
  write("----- End candidate body -----");
  const requestId = randomUUID();
  const args = ["--lease-id", c.lease_id, "--request-id", requestId,
    "--candidate-id", id, "--expected-generation", String(c.generation),
    "--expected-binding-generation", String(c.binding_generation)];
  const checked = call(cli, "commit-check", project, args);
  if (checked.code !== 0 || !checked.value ||
      checked.value.candidate_id !== id || checked.value.content_sha256 !== c.content_sha256 ||
      checked.value.session_id !== c.session_id || checked.value.lease_id !== c.lease_id ||
      checked.value.pane_id !== c.intended_pane_id ||
      checked.value.generation_before !== c.generation ||
      checked.value.binding_generation !== c.binding_generation ||
      checked.value.source_verification !== "unverified") {
    throw new Error(checked.value?.code || "COMMIT_CHECK_MISMATCH");
  }
  write(`Request: ${requestId}\nPolicy: ${checked.value.policy?.result}\nGate: ${checked.value.gate}`);
  if (checked.value.status === "policy_blocked") return { status: "policy_blocked", request_id: requestId };
  if (checked.value.status !== "awaiting_source_confirmation")
    throw new Error("SOURCE_CONFIRMATION_STATE_MISMATCH");
  write("Review the body and identity above. The CLI cannot prove which Agent wrote the file.");
  const expected = `COMMIT ${id} ${c.content_sha256}`;
  const answer = (await ask(`Type '${expected}' to assert the source and submit (Enter cancels): `)).trim();
  if (answer !== expected) return { status: "cancelled", request_id: requestId };
  const confirmed = call(cli, "confirm-candidate", project,
    [...args, "--expected-content-sha256", c.content_sha256,
      "--decision", "reviewed_candidate_source"]);
  if (confirmed.code !== 0 || confirmed.value?.status !== "human_asserted" ||
      confirmed.value.candidate_id !== id || confirmed.value.request_id !== requestId)
    throw new Error(confirmed.value?.code || "SOURCE_CONFIRMATION_UNKNOWN");
  const committed = call(cli, "commit", project, args);
  if (![0, 6].includes(committed.code) ||
      !["committed", "rejected"].includes(committed.value?.status) ||
      committed.value.request_id !== requestId) {
    throw new Error(`COMMIT_OUTCOME_UNKNOWN; inspect host receipt for request ${requestId}`);
  }
  write(`Result: ${committed.value.status}  Request: ${requestId}`);
  return { status: committed.value.status, request_id: requestId };
}

async function main() {
  if (!process.stdin.isTTY) throw new Error("INTERACTIVE_TERMINAL_REQUIRED");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Ralph-Lisa candidate review / Herdr");
    await reviewCandidate({ project: projectFromStatus(), cli: cliSettings(),
      ask: (prompt) => input.question(prompt) });
  } finally { input.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
