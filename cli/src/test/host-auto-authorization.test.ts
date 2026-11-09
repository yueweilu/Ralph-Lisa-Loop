import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { autoAuthorizationForSeat, grantAutoAuthorization, readAutoAuthorization } from "../host/auto-authorization.js";

const cli = path.join(__dirname, "..", "cli.js");

describe("session-scoped auto authorization record", () => {
  it("requires an explicit auto launch and a bound initial turn, without making a human assertion", () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-auto-auth-")));
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    try {
      const init = spawnSync(process.execPath, [cli, "init", "--minimal", project],
        { cwd: project, encoding: "utf8" });
      assert.equal(init.status, 0, init.stdout + init.stderr);
      const state = path.join(project, ".dual-agent");
      const host = path.join(state, "host");
      const session = JSON.parse(fs.readFileSync(path.join(state, "session.json"), "utf8"));
      const launchRequestId = crypto.randomUUID();
      const launchFile = path.join(state, "herdr-launch-intent.json");
      const launch = { schema: 1, request_id: launchRequestId, project_realpath: project,
        session_id: session.session_id,
        task_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(state, "task.md"))).digest("hex"),
        permission_profile: "interactive", auto_commit: false };
      fs.writeFileSync(launchFile, JSON.stringify(launch));
      const lease = run("host", "claim", "--project", project,
        "--host", "herdr", "--owner-id", crypto.randomUUID(), "--json");
      const ralph = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "ralph", "--workspace-id", "w1", "--pane-id", "w1:p1",
        "--agent-target", "ralph", "--json");
      launch.auto_commit = true;
      fs.writeFileSync(launchFile, JSON.stringify(launch));
      assert.throws(() => grantAutoAuthorization(project, lease.lease_id, launchRequestId,
        ralph.binding_generation, "cli_auto_host_herdr"), /bound initial turn/);
      const lisa = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "lisa", "--workspace-id", "w1", "--pane-id", "w1:p2",
        "--agent-target", "lisa", "--json");
      const snapshot = run("host", "snapshot", "--project", project, "--json");
      run("host", "prepare-generation", "--project", project,
        "--lease-id", lease.lease_id, "--expected-digest", snapshot.state_digest, "--json");
      launch.auto_commit = false;
      fs.writeFileSync(launchFile, JSON.stringify(launch));
      assert.throws(() => grantAutoAuthorization(project, lease.lease_id, launchRequestId,
        lisa.binding_generation, "cli_auto_host_herdr"), /Launch did not grant/);
      assert.equal(readAutoAuthorization(host, project, state, session.session_id, lease.lease_id), null);
      launch.auto_commit = true;
      fs.writeFileSync(launchFile, JSON.stringify(launch));
      const granted = grantAutoAuthorization(project, lease.lease_id, launchRequestId,
        lisa.binding_generation, "cli_auto_host_herdr");
      assert.equal(granted.source_verification, "unverified");
      assert.equal(granted.lease_id, lease.lease_id);
      assert.equal(granted.seats.ralph.pane_id, "w1:p1");
      assert.equal(granted.seats.lisa.pane_id, "w1:p2");
      assert.deepEqual(grantAutoAuthorization(project, lease.lease_id, launchRequestId,
        lisa.binding_generation, "cli_auto_host_herdr"), granted);
      assert.deepEqual(readAutoAuthorization(host, project, state, session.session_id, lease.lease_id), granted);
      assert.equal(fs.existsSync(path.join(host, "confirmations")), false);
      const after = run("host", "snapshot", "--project", project, "--json");
      assert.equal(after.generation, 0);
      assert.equal(after.candidate_count, 0);
      assert.deepEqual(autoAuthorizationForSeat(host, project, state, session.session_id,
        lease.lease_id, lisa.binding_generation, "w1", "ralph", "w1:p1", "ralph"), granted);
      assert.equal(autoAuthorizationForSeat(host, project, state, session.session_id,
        lease.lease_id, lisa.binding_generation + 1, "w1", "ralph", "w1:p1", "ralph"), null);
      assert.throws(() => grantAutoAuthorization(project, crypto.randomUUID(), launchRequestId,
        lisa.binding_generation, "cli_auto_host_herdr"), /bound initial turn/);
      fs.appendFileSync(path.join(state, "task.md"), "Changed task\n");
      assert.equal(autoAuthorizationForSeat(host, project, state, session.session_id,
        lease.lease_id, lisa.binding_generation, "w1", "ralph", "w1:p1", "ralph"), null);
      fs.writeFileSync(path.join(host, "auto-authorizations", `${lease.lease_id}.json`),
        JSON.stringify({ ...granted, source_verification: "verified" }));
      assert.throws(() => readAutoAuthorization(host, project, state, session.session_id, lease.lease_id),
        /Invalid auto authorization/);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });

  it("commits an authorized candidate without fabricating a human confirmation", () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-auto-commit-")));
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
      const session = JSON.parse(fs.readFileSync(path.join(state, "session.json"), "utf8"));
      const launchRequestId = crypto.randomUUID();
      fs.writeFileSync(path.join(state, "herdr-launch-intent.json"), JSON.stringify({
        schema: 1, request_id: launchRequestId, project_realpath: project,
        session_id: session.session_id,
        task_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(state, "task.md"))).digest("hex"),
        permission_profile: "interactive", auto_commit: true,
      }));
      const lease = run("host", "claim", "--project", project,
        "--host", "herdr", "--owner-id", crypto.randomUUID(), "--json");
      run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "ralph", "--workspace-id", "w1", "--pane-id", "w1:p1",
        "--agent-target", "ralph", "--json");
      const binding = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
        "--role", "lisa", "--workspace-id", "w1", "--pane-id", "w1:p2",
        "--agent-target", "lisa", "--json");
      const baseline = run("host", "snapshot", "--project", project, "--json");
      run("host", "prepare-generation", "--project", project,
        "--lease-id", lease.lease_id, "--expected-digest", baseline.state_digest, "--json");
      grantAutoAuthorization(project, lease.lease_id, launchRequestId,
        binding.binding_generation, "cli_auto_host_herdr");
      const candidateId = crypto.randomUUID();
      const candidateFile = path.join(project, "candidate.md");
      fs.writeFileSync(candidateFile, "[PLAN] Create the README.\n\nTest Plan: read README.md after writing it.\n");
      run("host", "propose", "--project", project, "--role", "ralph",
        "--file", candidateFile, "--candidate-id", candidateId, "--json");
      const requestId = crypto.randomUUID();
      const args = ["--project", project, "--lease-id", lease.lease_id,
        "--request-id", requestId, "--candidate-id", candidateId,
        "--expected-generation", "0", "--expected-binding-generation",
        String(binding.binding_generation), "--json"];
      const check = run("host", "commit-check", ...args);
      assert.equal(check.status, "auto_source_authorized");
      assert.equal(check.human_confirmation, "absent");
      assert.equal(check.auto_authorization_launch_request_id, launchRequestId);
      const committed = run("host", "commit", ...args);
      assert.equal(committed.status, "committed");
      assert.equal(committed.source_confirmation, "session_authorized_auto");
      assert.equal(committed.source_verification, "unverified");
      assert.equal(committed.auto_authorization_launch_request_id, launchRequestId);
      assert.equal(fs.existsSync(path.join(host, "confirmations")), false);
      assert.equal(run("host", "snapshot", "--project", project, "--json").generation, 1);
      assert.equal(run("host", "receipt", "--project", project,
        "--request-id", requestId, "--json").status, "committed");
      assert.deepEqual(run("host", "commit", ...args), committed);
      fs.writeFileSync(path.join(host, "auto-authorizations", `${lease.lease_id}.json`),
        JSON.stringify({ ...readAutoAuthorization(host, project, state, session.session_id, lease.lease_id),
          source_verification: "verified" }));
      const invalidReceipt = invoke("host", "receipt", "--project", project,
        "--request-id", requestId, "--json");
      assert.equal(invalidReceipt.status, 7, invalidReceipt.stdout);
      assert.equal(JSON.parse(invalidReceipt.stdout).status, "needs_reconcile");
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
