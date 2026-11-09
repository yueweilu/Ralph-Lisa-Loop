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
});
