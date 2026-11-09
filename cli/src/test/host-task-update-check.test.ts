import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { checkTaskUpdate } from "../host/task-update-check.js";

const cli = path.join(__dirname, "..", "cli.js");

describe("host task-update read-only preflight", () => {
  it("identifies the current task, target seat, and stale candidate without writing business state", () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-task-check-")));
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    try {
      const initialized = spawnSync(process.execPath, [cli, "init", "--minimal", project],
        { cwd: project, encoding: "utf8" });
      assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
      const lease = run("host", "claim", "--project", project, "--host", "herdr",
        "--owner-id", crypto.randomUUID(), "--json");
      run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "ralph", "--workspace-id", "w1", "--pane-id", "p1",
        "--agent-target", "ralph", "--json");
      const bound = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "lisa", "--workspace-id", "w1", "--pane-id", "p2",
        "--agent-target", "lisa", "--json");
      const baseline = run("host", "snapshot", "--project", project, "--json");
      run("host", "prepare-generation", "--project", project, "--lease-id", lease.lease_id,
        "--expected-digest", baseline.state_digest, "--json");
      const candidateFile = path.join(project, "candidate.md");
      fs.writeFileSync(candidateFile, "[PLAN] Old task.\n\nTest Plan: inspect result.\n");
      const proposed = run("host", "propose", "--project", project, "--role", "ralph",
        "--file", candidateFile, "--candidate-id", crypto.randomUUID(), "--json");
      const taskFile = path.join(project, "new-task.txt");
      const text = "Build a small homepage.\n";
      fs.writeFileSync(taskFile, text);
      const hash = crypto.createHash("sha256").update(text).digest("hex");
      const state = path.join(project, ".dual-agent");
      const taskBefore = fs.readFileSync(path.join(state, "task.md"));
      const check = checkTaskUpdate(project, lease.lease_id, crypto.randomUUID(), 0,
        bound.binding_generation, baseline.state_digest, "switch", taskFile, hash);
      assert.equal(check.status, "ready");
      assert.equal(check.target_role, "ralph");
      assert.deepEqual(check.stale_candidate_ids, [proposed.candidate_id]);
      assert.equal(check.content_sha256, hash);
      assert.deepEqual(fs.readFileSync(path.join(state, "task.md")), taskBefore);
      const publicCheck = run("host", "task-update-check", "--project", project,
        "--lease-id", lease.lease_id, "--request-id", crypto.randomUUID(),
        "--expected-generation", "0", "--expected-binding-generation",
        String(bound.binding_generation), "--expected-digest", baseline.state_digest,
        "--mode", "supplement", "--file", taskFile, "--content-sha256", hash, "--json");
      assert.equal(publicCheck.target_role, "ralph");
      assert.equal(publicCheck.mode, "supplement");
      assert.equal(run("host", "snapshot", "--project", project, "--json").generation, 0);
      assert.throws(() => checkTaskUpdate(project, lease.lease_id, crypto.randomUUID(), 0,
        bound.binding_generation, baseline.state_digest, "switch", taskFile, "0".repeat(64)),
      /Task text changed/);
      assert.throws(() => checkTaskUpdate(project, lease.lease_id, crypto.randomUUID(), 1,
        bound.binding_generation, baseline.state_digest, "switch", taskFile, hash),
      /generation is missing or stale/);
      assert.throws(() => checkTaskUpdate(project, crypto.randomUUID(), crypto.randomUUID(), 0,
        bound.binding_generation, baseline.state_digest, "switch", taskFile, hash),
      /another coordinator/);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
