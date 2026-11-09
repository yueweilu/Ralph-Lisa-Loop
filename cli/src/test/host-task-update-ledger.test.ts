import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { businessDigest } from "../host/business.js";
import { type TaskUpdateIntent, type TaskUpdateReceipt } from "../host/task-update-record.js";

const cli = path.join(__dirname, "..", "cli.js");
const sha = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");

describe("mixed host transition ledger", () => {
  it("accepts a historical task event before a human-confirmed submission and detects a changed event", () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-task-ledger-")));
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
      const host = path.join(state, "host");
      const lease = run("host", "claim", "--project", project,
        "--host", "herdr", "--owner-id", crypto.randomUUID(), "--json");
      run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "ralph", "--workspace-id", "w1", "--pane-id", "p1",
        "--agent-target", "ralph", "--json");
      const bound = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "lisa", "--workspace-id", "w1", "--pane-id", "p2",
        "--agent-target", "lisa", "--json");
      const before = run("host", "snapshot", "--project", project, "--json");
      run("host", "prepare-generation", "--project", project, "--lease-id", lease.lease_id,
        "--expected-digest", before.state_digest, "--json");
      const requestId = crypto.randomUUID();
      const task = "Build a homepage.\n";
      const updates = [
        ["task.md", Buffer.from(fs.readFileSync(path.join(state, "task.md"), "utf8") +
          "\n---\nUpdated: 2026-11-09\n\n" + task)],
        ["history.md", Buffer.from(fs.readFileSync(path.join(state, "history.md"), "utf8") +
          "\n[System] [SCOPE] Task switched.\n")],
        ["last_action.txt", Buffer.from("[System] Task switched.\n")],
      ] as const;
      const changes = updates.map(([name, bytes]) => ({ name, action: "write" as const,
        before_sha256: sha(fs.readFileSync(path.join(state, name))), after_sha256: sha(bytes) }));
      for (const [name, bytes] of updates) fs.writeFileSync(path.join(state, name), bytes);
      const afterDigest = businessDigest(state, "ralph", 1, before.step);
      const intent: TaskUpdateIntent = {
        schema: 1, event: "task_update", status: "prepared", request_id: requestId,
        project_realpath: project, state_realpath: state, session_id: before.session_id,
        lease_id: lease.lease_id, binding_generation: bound.binding_generation,
        mode: "switch", source_verification: "unverified", content_sha256: sha(task),
        generation_before: 0, task_version_before: 1, task_version_after: 2,
        turn_before: "ralph", round_before: 1, step_before: before.step,
        turn_after: "ralph", round_after: 1, step_after: "planning",
        state_digest_before: before.state_digest, state_digest_after: afterDigest,
        changes, created_at: new Date().toISOString(),
      };
      const receipt: TaskUpdateReceipt = {
        schema: 1, event: "task_update", status: "task_updated", request_id: requestId,
        project_realpath: project, state_realpath: state, session_id: before.session_id,
        lease_id: lease.lease_id, binding_generation: bound.binding_generation,
        mode: "switch", source_verification: "unverified", content_sha256: sha(task),
        generation_before: 0, generation_after: 1, task_version_before: 1, task_version_after: 2,
        turn_after: "ralph", round_after: 1, step_after: "planning",
        state_digest_after: afterDigest, committed_at: new Date().toISOString(),
      };
      fs.mkdirSync(path.join(host, "task-update-archived"));
      fs.mkdirSync(path.join(host, "task-update-receipts"));
      fs.writeFileSync(path.join(host, "task-update-archived", `${requestId}.json`), JSON.stringify(intent));
      fs.writeFileSync(path.join(host, "task-update-receipts", `${requestId}.json`), JSON.stringify(receipt));
      const generationFile = path.join(host, "generation.json");
      const generation = JSON.parse(fs.readFileSync(generationFile, "utf8"));
      fs.writeFileSync(generationFile, JSON.stringify({ ...generation, generation: 1,
        last_receipt_id: requestId, state_digest: afterDigest }));
      const after = run("host", "snapshot", "--project", project, "--json");
      assert.equal(after.generation, 1);
      assert.equal(after.last_receipt_id, requestId);
      const taskFile = path.join(project, "new-task.txt");
      fs.writeFileSync(taskFile, task);
      const check = run("host", "task-update-check", "--project", project,
        "--lease-id", lease.lease_id, "--request-id", crypto.randomUUID(),
        "--expected-generation", "1", "--expected-binding-generation",
        String(bound.binding_generation), "--expected-digest", after.state_digest,
        "--mode", "supplement", "--file", taskFile, "--content-sha256", sha(task), "--json");
      assert.equal(check.task_version_before, 2);
      const candidateId = crypto.randomUUID();
      const candidate = path.join(project, "candidate.md");
      fs.writeFileSync(candidate, "[PLAN] Create the homepage.\n\nTest Plan: inspect the homepage.\n");
      run("host", "propose", "--project", project, "--role", "ralph",
        "--file", candidate, "--candidate-id", candidateId, "--json");
      const commitArgs = ["--project", project, "--lease-id", lease.lease_id,
        "--request-id", crypto.randomUUID(), "--candidate-id", candidateId,
        "--expected-generation", "1", "--expected-binding-generation",
        String(bound.binding_generation), "--json"];
      const commitCheck = run("host", "commit-check", ...commitArgs);
      assert.equal(commitCheck.status, "awaiting_source_confirmation");
      run("host", "confirm-candidate", ...commitArgs.slice(0, -1),
        "--expected-content-sha256", commitCheck.content_sha256,
        "--decision", "reviewed_candidate_source", "--json");
      const committed = run("host", "commit", ...commitArgs);
      assert.equal(committed.generation_after, 2);
      assert.equal(run("host", "snapshot", "--project", project, "--json").generation, 2);
      fs.writeFileSync(path.join(host, "task-update-receipts", `${requestId}.json`),
        JSON.stringify({ ...receipt, content_sha256: "0".repeat(64) }));
      const damaged = invoke("host", "snapshot", "--project", project, "--json");
      assert.equal(damaged.status, 7);
      assert.equal(JSON.parse(damaged.stdout).code, "NEEDS_RECONCILE");
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
