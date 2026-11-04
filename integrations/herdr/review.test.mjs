import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reviewCandidate } from "./review.mjs";

const cliFile = fileURLToPath(new URL("../../cli/dist/cli.js", import.meta.url));
const cli = [process.execPath, cliFile];
let project;
let candidate;

function command(...args) {
  const result = spawnSync(cli[0], [cli[1], ...args], { encoding: "utf8", cwd: project });
  return { code: result.status, value: JSON.parse(result.stdout) };
}

function host(action, tail = []) {
  return command("host", action, "--project", project, ...tail, "--json");
}

beforeEach(() => {
  project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-review-")));
  const init = spawnSync(process.execPath, [cliFile, "init", "--minimal", project], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(project, "proposal.md"), "[PLAN] Review the task\n");
  const claimed = host("claim", ["--host", "herdr", "--owner-id", randomUUID()]);
  assert.equal(claimed.code, 0);
  const leaseId = claimed.value.lease_id;
  const bound = host("bind-seat", ["--lease-id", leaseId, "--role", "ralph",
    "--workspace-id", "workspace-1", "--pane-id", "pane-r",
    "--agent-target", "agent-r"]);
  assert.equal(bound.code, 0);
  const digest = host("snapshot").value.state_digest;
  assert.equal(host("prepare-generation", ["--lease-id", leaseId,
    "--expected-digest", digest]).code, 0);
  const proposed = host("propose", ["--role", "ralph", "--file", "proposal.md",
    "--candidate-id", randomUUID()]);
  assert.equal(proposed.code, 0);
  candidate = proposed.value;
});

afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

test("review displays stored body and identity, and cancellation leaves business state alone", async () => {
  const lines = [];
  const result = await reviewCandidate({ project, cli, write: (line) => lines.push(line),
    ask: async (prompt) => prompt.startsWith("Candidate ID") ? candidate.candidate_id : "" });
  assert.equal(result.status, "cancelled");
  assert.ok(lines.includes("[PLAN] Review the task\n"));
  assert.ok(lines.some((line) => line.includes(candidate.intended_pane_id)));
  assert.equal(host("snapshot").value.turn, "ralph");
  assert.equal(host("receipt", ["--request-id", result.request_id]).value.status, "unknown");
});

test("typed candidate ID and digest submit once through the existing confirmation gate", async () => {
  const answers = [candidate.candidate_id,
    `COMMIT ${candidate.candidate_id} ${candidate.content_sha256}`];
  const result = await reviewCandidate({ project, cli, write: () => {},
    ask: async () => answers.shift() });
  assert.equal(result.status, "committed");
  assert.equal(host("snapshot").value.turn, "lisa");
  const receipt = host("receipt", ["--request-id", result.request_id]);
  assert.equal(receipt.code, 0);
  assert.equal(receipt.value.status, "committed");
  assert.equal(receipt.value.source_verification, "unverified");
  assert.equal(receipt.value.source_confirmation, "human_asserted");
});

test("tampered candidate stops before the human confirmation prompt", async () => {
  fs.appendFileSync(path.join(project, ".dual-agent", "host", "candidates",
    candidate.candidate_id, "content.txt"), "tampered\n");
  let prompts = 0;
  await assert.rejects(() => reviewCandidate({ project, cli, write: () => {},
    ask: async () => { prompts++; return candidate.candidate_id; } }), /NEEDS_RECONCILE/);
  assert.equal(prompts, 0);
});
