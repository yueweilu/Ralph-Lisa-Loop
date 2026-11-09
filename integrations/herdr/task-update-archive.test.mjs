import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(root, "../../cli/dist/cli.js");
const coordinator = path.join(root, "coordinator.mjs");

test("accepted task delivery can close an interrupted queue before lease recovery", () => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-task-archive-")));
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  const stateRoot = path.join(temp, "plugin-state");
  fs.mkdirSync(project);
  fs.mkdirSync(config);
  const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: stateRoot };
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ project,
    rll_cli_argv: [process.execPath, cli] }));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args],
    { cwd: project, env, encoding: "utf8" });
  const run = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const archive = (id, generation) => spawnSync(process.execPath,
    [coordinator, "archive-delivered-task-request", id, String(generation)],
    { cwd: project, env, encoding: "utf8" });
  try {
    assert.equal(invoke("init", "--minimal", project).status, 0);
    const owner = crypto.randomUUID();
    const lease = run("host", "claim", "--project", project, "--host", "herdr",
      "--owner-id", owner, "--json");
    run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
      "--role", "ralph", "--workspace-id", "w1", "--pane-id", "p1",
      "--agent-target", "ralph", "--json");
    const binding = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
      "--role", "lisa", "--workspace-id", "w1", "--pane-id", "p2",
      "--agent-target", "lisa", "--json");
    const before = run("host", "snapshot", "--project", project, "--json");
    run("host", "prepare-generation", "--project", project, "--lease-id", lease.lease_id,
      "--expected-digest", before.state_digest, "--json");
    const requestId = crypto.randomUUID();
    const body = "Build the new page.\n";
    const file = path.join(project, "new-task.txt");
    fs.writeFileSync(file, body);
    const contentSha = crypto.createHash("sha256").update(body).digest("hex");
    const receipt = run("host", "task-update", "--project", project,
      "--lease-id", lease.lease_id, "--request-id", requestId,
      "--expected-generation", "0", "--expected-binding-generation",
      String(binding.binding_generation), "--expected-digest", before.state_digest,
      "--mode", "switch", "--file", file, "--content-sha256", contentSha, "--json");
    const after = run("host", "snapshot", "--project", project, "--json");
    const queue = path.join(project, ".dual-agent", "host", "task-update-requests");
    fs.mkdirSync(queue);
    fs.writeFileSync(path.join(queue, `${requestId}.json`), JSON.stringify({
      schema: 1, status: "requested", request_id: requestId, project_realpath: project,
      session_id: before.session_id, generation: 0,
      binding_generation: binding.binding_generation,
      mode: "switch", content_sha256: contentSha,
      source_verification: "unverified",
    }));
    const key = crypto.createHash("sha256").update(project).digest("hex");
    const pluginDir = path.join(stateRoot, "sessions", key);
    fs.mkdirSync(pluginDir, { recursive: true });
    const plan = { workspace_id: "w1", seats: {
      ralph: { pane_id: "p1" }, lisa: { pane_id: "p2" },
    } };
    const record = { schema: 1, phase: "paused", project_realpath: project,
      session_id: before.session_id, lease_id: lease.lease_id, owner_id: owner,
      binding_generation: binding.binding_generation, plan,
      cursor_generation: 1, cursor_receipt_id: requestId, cursor_turn: "ralph" };
    fs.writeFileSync(path.join(pluginDir, "record.json"), JSON.stringify(record));
    const delivery = { schema: 1, status: "accepted", owner_id: owner,
      lease_id: lease.lease_id, role: "ralph", workspace_id: "w1",
      pane_id: "p1", request_id: requestId, generation: 1 };
    const deliveryFile = path.join(pluginDir, `delivery-${requestId}.json`);
    fs.writeFileSync(deliveryFile, JSON.stringify(delivery));
    assert.equal(invoke("host", "recovery-check", "--project", project, "--json").status, 7);
    const wrong = archive(requestId, 2);
    assert.equal(wrong.status, 7);
    assert.equal(JSON.parse(wrong.stdout).code, "TASK_REQUEST_ARCHIVE_EVIDENCE_MISMATCH");
    fs.writeFileSync(deliveryFile, JSON.stringify({ ...delivery, status: "intent" }));
    assert.equal(archive(requestId, 1).status, 7);
    fs.writeFileSync(deliveryFile, JSON.stringify(delivery));
    fs.writeFileSync(path.join(queue, `${requestId}.json`), JSON.stringify({
      ...JSON.parse(fs.readFileSync(path.join(queue, `${requestId}.json`), "utf8")),
      content_sha256: "0".repeat(64),
    }));
    assert.equal(archive(requestId, 1).status, 7);
    fs.writeFileSync(path.join(queue, `${requestId}.json`), JSON.stringify({
      schema: 1, status: "requested", request_id: requestId, project_realpath: project,
      session_id: before.session_id, generation: 0,
      binding_generation: binding.binding_generation,
      mode: "switch", content_sha256: contentSha, source_verification: "unverified",
    }));
    const closed = archive(requestId, 1);
    assert.equal(closed.status, 0, closed.stdout + closed.stderr);
    assert.equal(JSON.parse(closed.stdout).status, "task_request_archived");
    assert.equal(fs.existsSync(path.join(queue, `${requestId}.json`)), false);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host",
      "task-update-requests-archived", `${requestId}.json`)), true);
    assert.equal(archive(requestId, 1).status, 7);
    const recovery = invoke("host", "recovery-check", "--project", project, "--json");
    assert.equal(recovery.status, 0, recovery.stdout + recovery.stderr);
    assert.equal(JSON.parse(recovery.stdout).status, "review_required");
    assert.equal(after.generation, receipt.generation_after);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("uncommitted request can be abandoned only after matching no-write evidence", () => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-task-abandon-")));
  const project = path.join(temp, "project");
  const config = path.join(temp, "config");
  const stateRoot = path.join(temp, "plugin-state");
  fs.mkdirSync(project);
  fs.mkdirSync(config);
  const env = { ...process.env, HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: stateRoot };
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ project,
    rll_cli_argv: [process.execPath, cli] }));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args],
    { cwd: project, env, encoding: "utf8" });
  const run = (...args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const abandon = (id, generation, decision = "reviewed-no-commit") =>
    spawnSync(process.execPath, [coordinator, "abandon-uncommitted-task-request",
      id, String(generation), decision], { cwd: project, env, encoding: "utf8" });
  try {
    assert.equal(invoke("init", "--minimal", project).status, 0);
    const owner = crypto.randomUUID();
    const lease = run("host", "claim", "--project", project, "--host", "herdr",
      "--owner-id", owner, "--json");
    run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
      "--role", "ralph", "--workspace-id", "w1", "--pane-id", "p1",
      "--agent-target", "ralph", "--json");
    const binding = run("host", "bind-seat", "--project", project, "--lease-id", lease.lease_id,
      "--role", "lisa", "--workspace-id", "w1", "--pane-id", "p2",
      "--agent-target", "lisa", "--json");
    const before = run("host", "snapshot", "--project", project, "--json");
    run("host", "prepare-generation", "--project", project, "--lease-id", lease.lease_id,
      "--expected-digest", before.state_digest, "--json");
    const requestId = crypto.randomUUID();
    const queue = path.join(project, ".dual-agent", "host", "task-update-requests");
    fs.mkdirSync(queue);
    const request = { schema: 1, status: "requested", request_id: requestId,
      project_realpath: project, session_id: before.session_id,
      workspace_id: "w1", pane_id: "p1", terminal_id: "term-r",
      agent_target: "ralph", source_verification: "unverified",
      mode: "switch", content_sha256: "a".repeat(64),
      generation: 0, binding_generation: binding.binding_generation,
      state_digest: before.state_digest, last_receipt_id: null };
    const requestFile = path.join(queue, `${requestId}.json`);
    fs.writeFileSync(requestFile, JSON.stringify(request));
    const key = crypto.createHash("sha256").update(project).digest("hex");
    const pluginDir = path.join(stateRoot, "sessions", key);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "record.json"), JSON.stringify({
      schema: 1, phase: "needs_reconcile", project_realpath: project,
      session_id: before.session_id, lease_id: lease.lease_id, owner_id: owner,
      binding_generation: binding.binding_generation,
      cursor_generation: 0, cursor_receipt_id: null, cursor_turn: "ralph",
      plan: { workspace_id: "w1", seats: {
        ralph: { pane_id: "p1", terminal_id: "term-r" },
        lisa: { pane_id: "p2" },
      } },
    }));
    assert.equal(invoke("host", "recovery-check", "--project", project, "--json").status, 7);
    assert.equal(abandon(requestId, 0, "yes").status, 7);
    fs.writeFileSync(requestFile, JSON.stringify({ ...request, state_digest: "0".repeat(64) }));
    assert.equal(abandon(requestId, 0).status, 7);
    fs.writeFileSync(requestFile, JSON.stringify(request));
    const result = abandon(requestId, 0);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "task_request_abandoned");
    assert.equal(fs.existsSync(requestFile), false);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host",
      "task-update-requests-abandoned", `${requestId}.json`)), true);
    assert.equal(abandon(requestId, 0).status, 7);
    assert.equal(run("host", "recovery-check", "--project", project, "--json").status,
      "review_required");
    assert.equal(run("host", "snapshot", "--project", project, "--json").generation, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
