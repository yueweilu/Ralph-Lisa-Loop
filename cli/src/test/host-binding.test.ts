import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

describe("host seat binding", () => {
  let project: string;
  let leaseId: string;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  function bind(role: string, pane: string, target: string, workspace = "workspace-1", lease = leaseId) {
    return run("host", "bind-seat", "--project", project, "--lease-id", lease,
      "--role", role, "--workspace-id", workspace, "--pane-id", pane,
      "--agent-target", target, "--json");
  }

  function snapshot() {
    return JSON.parse(run("host", "snapshot", "--project", project, "--json").stdout);
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-binding-")));
    assert.equal(run("init", "--minimal", project).status, 0);
    const claim = run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", randomUUID(), "--json");
    assert.equal(claim.status, 0, claim.stdout);
    leaseId = JSON.parse(claim.stdout).lease_id;
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("binds two distinct seats and exposes a partial then complete snapshot", () => {
    const ralph = bind("ralph", "pane-r", "target-r");
    assert.equal(ralph.status, 0, ralph.stdout);
    const first = JSON.parse(ralph.stdout);
    assert.equal(first.binding_generation, 1);
    assert.equal(first.seats.ralph.verification, "unverified");
    assert.equal(first.seats.lisa, null);
    assert.equal(snapshot().binding_state, "partial");

    const lisa = bind("lisa", "pane-l", "target-l");
    assert.equal(lisa.status, 0, lisa.stdout);
    const second = JSON.parse(lisa.stdout);
    assert.equal(second.binding_generation, 2);
    assert.equal(second.seats.ralph.pane_id, "pane-r");
    assert.equal(second.seats.lisa.pane_id, "pane-l");
    const view = snapshot();
    assert.equal(view.binding_state, "bound");
    assert.equal(view.binding_generation, 2);
    assert.equal(view.workspace_id, "workspace-1");
    assert.equal(view.seats.lisa.agent_target, "target-l");
    assert.equal("lease_id" in view, false);
  });

  it("returns the original binding on an identical retry and increments on a changed Pane", () => {
    const first = JSON.parse(bind("ralph", "pane-r", "target-r").stdout);
    const retry = JSON.parse(bind("ralph", "pane-r", "target-r").stdout);
    assert.deepEqual(retry, first);
    const moved = JSON.parse(bind("ralph", "pane-r2", "target-r").stdout);
    assert.equal(moved.binding_generation, 2);
    assert.equal(moved.seats.ralph.pane_id, "pane-r2");
  });

  it("rejects wrong lease, workspace, role, and duplicate Pane or Agent target", () => {
    assert.equal(JSON.parse(bind("ralph", "pane-r", "target-r", "workspace-1", randomUUID()).stdout).code, "LEASE_MISMATCH");
    assert.equal(JSON.parse(bind("unknown", "pane-r", "target-r").stdout).code, "INVALID_ARGUMENTS");
    assert.equal(bind("ralph", "pane-r", "target-r").status, 0);
    assert.equal(JSON.parse(bind("lisa", "pane-l", "target-l", "workspace-2").stdout).code, "WORKSPACE_MISMATCH");
    assert.equal(JSON.parse(bind("lisa", "pane-r", "target-l").stdout).code, "WRONG_SEAT");
    assert.equal(JSON.parse(bind("lisa", "pane-l", "target-r").stdout).code, "WRONG_SEAT");
    assert.equal(snapshot().binding_generation, 1);
  });

  it("marks bindings from a released lease stale and starts new lease bindings at a higher generation", () => {
    assert.equal(bind("ralph", "pane-r", "target-r").status, 0);
    assert.equal(bind("lisa", "pane-l", "target-l").status, 0);
    const released = run("host", "release", "--project", project, "--lease-id", leaseId, "--json");
    assert.equal(released.status, 0, released.stdout);
    assert.equal(snapshot().binding_state, "stale");
    const claim = run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", randomUUID(), "--json");
    assert.equal(claim.status, 0, claim.stdout);
    leaseId = JSON.parse(claim.stdout).lease_id;
    assert.equal(snapshot().binding_state, "stale");
    const next = bind("ralph", "pane-new", "target-new", "workspace-2");
    assert.equal(next.status, 0, next.stdout);
    const value = JSON.parse(next.stdout);
    assert.equal(value.binding_generation, 3);
    assert.equal(value.seats.lisa, null);
    assert.equal(snapshot().binding_state, "partial");
  });

  it("freezes a pending binding write before lease release or session mutation", () => {
    const pending = path.join(project, ".dual-agent", "host", "binding.pending");
    fs.writeFileSync(pending, "partial");
    assert.equal(JSON.parse(bind("ralph", "pane-r", "target-r").stdout).code, "NEEDS_RECONCILE");
    assert.equal(JSON.parse(run("host", "snapshot", "--project", project, "--json").stdout).code, "NEEDS_RECONCILE");
    assert.equal(run("host", "release", "--project", project, "--lease-id", leaseId, "--json").status, 7);
    assert.equal(run("submit-ralph", "[PLAN] blocked").status, 4);
  });

  it("refuses a binding record copied from another session", () => {
    assert.equal(bind("ralph", "pane-r", "target-r").status, 0);
    const file = path.join(project, ".dual-agent", "host", "binding.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.session_id = randomUUID();
    fs.writeFileSync(file, JSON.stringify(value) + "\n");
    const view = run("host", "snapshot", "--project", project, "--json");
    assert.equal(view.status, 7);
    assert.equal(JSON.parse(view.stdout).code, "NEEDS_RECONCILE");
    const retry = bind("lisa", "pane-l", "target-l");
    assert.equal(retry.status, 7);
    assert.equal(JSON.parse(retry.stdout).code, "NEEDS_RECONCILE");
  });
});
