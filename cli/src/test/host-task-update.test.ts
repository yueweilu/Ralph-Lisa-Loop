import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.join(__dirname, "..", "cli.js");

describe("host-managed task update", () => {
  it("writes a task event once, invalidates an old candidate, and keeps later submission working", () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-task-write-")));
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
    const run = (...args: string[]) => {
      const result = invoke(...args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    try {
      assert.equal(invoke("init", "--minimal", project).status, 0);
      const state = path.join(project, ".dual-agent");
      const lease = run("host", "claim", "--project", project, "--host", "herdr",
        "--owner-id", crypto.randomUUID(), "--json");
      run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "ralph", "--workspace-id", "w1", "--pane-id", "p1",
        "--agent-target", "ralph", "--json");
      const binding = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "lisa", "--workspace-id", "w1", "--pane-id", "p2",
        "--agent-target", "lisa", "--json");
      const baseline = run("host", "snapshot", "--project", project, "--json");
      run("host", "prepare-generation", "--project", project, "--lease-id", lease.lease_id,
        "--expected-digest", baseline.state_digest, "--json");
      const oldCandidate = crypto.randomUUID();
      const oldFile = path.join(project, "old-candidate.md");
      fs.writeFileSync(oldFile, "[PLAN] Old task.\n\nTest Plan: inspect old result.\n");
      run("host", "propose", "--project", project, "--role", "ralph",
        "--file", oldFile, "--candidate-id", oldCandidate, "--json");
      const taskFile = path.join(project, "task-change.txt");
      const body = "Build a homepage instead.\n";
      fs.writeFileSync(taskFile, body);
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const requestId = crypto.randomUUID();
      const updateArgs = ["--project", project, "--lease-id", lease.lease_id,
        "--request-id", requestId, "--expected-generation", "0",
        "--expected-binding-generation", String(binding.binding_generation),
        "--expected-digest", baseline.state_digest, "--mode", "switch",
        "--file", taskFile, "--content-sha256", hash, "--json"];
      const checked = run("host", "task-update-check", ...updateArgs);
      assert.equal(checked.task_version_before, 1);
      assert.deepEqual(checked.stale_candidate_ids, [oldCandidate]);
      const receipt = run("host", "task-update", ...updateArgs);
      assert.equal(receipt.status, "task_updated");
      assert.equal(receipt.generation_after, 1);
      assert.equal(receipt.task_version_after, 2);
      assert.deepEqual(run("host", "task-update", ...updateArgs), receipt);
      assert.deepEqual(run("host", "receipt", "--project", project,
        "--request-id", requestId, "--json"), receipt);
      const snapshot = run("host", "snapshot", "--project", project, "--json");
      assert.equal(snapshot.generation, 1);
      assert.equal(snapshot.last_receipt_id, requestId);
      assert.equal(snapshot.turn, "ralph");
      assert.match(fs.readFileSync(path.join(state, "task.md"), "utf8"), /Build a homepage instead/);
      const stale = invoke("host", "commit-check", "--project", project,
        "--lease-id", lease.lease_id, "--request-id", crypto.randomUUID(),
        "--candidate-id", oldCandidate, "--expected-generation", "0",
        "--expected-binding-generation", String(binding.binding_generation), "--json");
      assert.equal(stale.status, 5);
      assert.equal(JSON.parse(stale.stdout).code, "STALE_GENERATION");
      const candidateFile = path.join(project, "new-candidate.md");
      const candidateId = crypto.randomUUID();
      fs.writeFileSync(candidateFile, "[PLAN] Create the homepage.\n\nTest Plan: inspect the page.\n");
      run("host", "propose", "--project", project, "--role", "ralph",
        "--file", candidateFile, "--candidate-id", candidateId, "--json");
      const commitArgs = ["--project", project, "--lease-id", lease.lease_id,
        "--request-id", crypto.randomUUID(), "--candidate-id", candidateId,
        "--expected-generation", "1", "--expected-binding-generation",
        String(binding.binding_generation), "--json"];
      const commitCheck = run("host", "commit-check", ...commitArgs);
      assert.equal(commitCheck.status, "awaiting_source_confirmation");
      run("host", "confirm-candidate", ...commitArgs.slice(0, -1),
        "--expected-content-sha256", commitCheck.content_sha256,
        "--decision", "reviewed_candidate_source", "--json");
      assert.equal(run("host", "commit", ...commitArgs).generation_after, 2);
      const lisaTurn = run("host", "snapshot", "--project", project, "--json");
      assert.equal(lisaTurn.turn, "lisa");
      const supplement = "Also check the page title.\n";
      fs.writeFileSync(taskFile, supplement);
      const supplementHash = crypto.createHash("sha256").update(supplement).digest("hex");
      const supplementArgs = ["--project", project, "--lease-id", lease.lease_id,
        "--request-id", crypto.randomUUID(), "--expected-generation", "2",
        "--expected-binding-generation", String(binding.binding_generation),
        "--expected-digest", lisaTurn.state_digest, "--mode", "supplement",
        "--file", taskFile, "--content-sha256", supplementHash, "--json"];
      assert.equal(run("host", "task-update-check", ...supplementArgs).target_role, "lisa");
      const supplemented = run("host", "task-update", ...supplementArgs);
      assert.equal(supplemented.generation_after, 3);
      assert.equal(supplemented.task_version_after, 3);
      const afterSupplement = run("host", "snapshot", "--project", project, "--json");
      assert.equal(afterSupplement.turn, "lisa");
      assert.equal(afterSupplement.round, lisaTurn.round);
      const switchText = "Build a settings page instead.\n";
      fs.writeFileSync(taskFile, switchText);
      const switchHash = crypto.createHash("sha256").update(switchText).digest("hex");
      const switchArgs = ["--project", project, "--lease-id", lease.lease_id,
        "--request-id", crypto.randomUUID(), "--expected-generation", "3",
        "--expected-binding-generation", String(binding.binding_generation),
        "--expected-digest", afterSupplement.state_digest, "--mode", "switch",
        "--file", taskFile, "--content-sha256", switchHash, "--json"];
      const switched = run("host", "task-update", ...switchArgs);
      assert.equal(switched.task_version_after, 4);
      assert.equal(switched.turn_after, "ralph");
      assert.equal(switched.round_after, 1);
      const finalSnapshot = run("host", "snapshot", "--project", project, "--json");
      assert.equal(finalSnapshot.generation, 4);
      const host = path.join(state, "host");
      const appliedId = crypto.randomUUID();
      const latestIntent = JSON.parse(fs.readFileSync(path.join(host, "task-update-archived",
        `${switchArgs[switchArgs.indexOf("--request-id") + 1]}.json`), "utf8"));
      fs.writeFileSync(path.join(host, "task-update-intents", `${appliedId}.json`),
        JSON.stringify({ ...latestIntent, request_id: appliedId }));
      const applied = invoke("host", "receipt", "--project", project,
        "--request-id", appliedId, "--json");
      assert.equal(applied.status, 7);
      assert.equal(JSON.parse(applied.stdout).task_update_intent.audit_status, "applied");
      fs.unlinkSync(path.join(host, "task-update-intents", `${appliedId}.json`));
      const pendingId = crypto.randomUUID();
      const oldIntent = JSON.parse(fs.readFileSync(path.join(host, "task-update-archived",
        `${requestId}.json`), "utf8"));
      const pending = { ...oldIntent, request_id: pendingId, mode: "supplement",
        generation_before: 4, task_version_before: 4, task_version_after: 5,
        turn_before: finalSnapshot.turn, round_before: finalSnapshot.round,
        step_before: finalSnapshot.step, turn_after: finalSnapshot.turn,
        round_after: finalSnapshot.round, step_after: finalSnapshot.step,
        state_digest_before: finalSnapshot.state_digest,
        changes: oldIntent.changes.map((change: { name: string; action: string }) => ({
          name: change.name, action: "write",
          before_sha256: crypto.createHash("sha256")
            .update(fs.readFileSync(path.join(state, change.name))).digest("hex"),
          after_sha256: "0".repeat(64),
        })),
      };
      fs.writeFileSync(path.join(host, "task-update-intents", `${pendingId}.json`),
        JSON.stringify(pending));
      const uncertain = invoke("host", "receipt", "--project", project,
        "--request-id", pendingId, "--json");
      assert.equal(uncertain.status, 7);
      const evidence = JSON.parse(uncertain.stdout);
      assert.equal(evidence.status, "needs_reconcile");
      assert.equal(evidence.task_update_intent.audit_status, "before");
      assert.deepEqual(evidence.task_update_intent.unmatched_files, []);
      assert.equal(invoke("host", "snapshot", "--project", project, "--json").status, 7);
      fs.appendFileSync(path.join(state, "task.md"), "\ninterrupted write\n");
      const partial = invoke("host", "receipt", "--project", project,
        "--request-id", pendingId, "--json");
      assert.equal(partial.status, 7);
      assert.equal(JSON.parse(partial.stdout).task_update_intent.audit_status, "partial");
      assert.deepEqual(JSON.parse(partial.stdout).task_update_intent.unmatched_files, ["task.md"]);
      fs.writeFileSync(path.join(state, "turn.txt"), "invalid\n");
      const torn = invoke("host", "receipt", "--project", project,
        "--request-id", pendingId, "--json");
      assert.equal(torn.status, 7);
      assert.equal(JSON.parse(torn.stdout).task_update_intent.audit_status, "partial");
      assert.equal(JSON.parse(torn.stdout).task_update_intent.state_digest_observed, null);
      assert.deepEqual(JSON.parse(torn.stdout).task_update_intent.unmatched_files,
        ["task.md", "turn.txt"]);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
