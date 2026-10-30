import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

describe("host candidate inbox", () => {
  let project: string;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  function snapshot() {
    return run("host", "snapshot", "--project", project, "--json");
  }

  function propose(id: string, role = "ralph", file = "proposal.md") {
    return run("host", "propose", "--project", project, "--role", role,
      "--file", file, "--candidate-id", id, "--json");
  }

  function claim() {
    const result = run("host", "claim", "--project", project,
      "--host", "herdr", "--owner-id", randomUUID(), "--json");
    assert.equal(result.status, 0, result.stdout);
    return JSON.parse(result.stdout);
  }

  function prepare(leaseId: string) {
    const digest = JSON.parse(snapshot().stdout).state_digest;
    const result = run("host", "prepare-generation", "--project", project,
      "--lease-id", leaseId, "--expected-digest", digest, "--json");
    assert.equal(result.status, 0, result.stdout);
  }

  function bind(leaseId: string, role = "ralph") {
    const result = run("host", "bind-seat", "--project", project,
      "--lease-id", leaseId, "--role", role, "--workspace-id", "workspace-1",
      "--pane-id", role === "ralph" ? "pane-r" : "pane-l",
      "--agent-target", role === "ralph" ? "agent-r" : "agent-l", "--json");
    assert.equal(result.status, 0, result.stdout);
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-candidate-")));
    const init = run("init", "--minimal", project);
    assert.equal(init.status, 0, init.stderr);
    fs.writeFileSync(path.join(project, "proposal.md"), "[PLAN] Review the task\n");
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("stores an immutable, unverified candidate without submitting it", () => {
    const lease = claim();
    bind(lease.lease_id);
    prepare(lease.lease_id);
    const state = path.join(project, ".dual-agent");
    const workBefore = fs.readFileSync(path.join(state, "work.md"));
    const turnBefore = fs.readFileSync(path.join(state, "turn.txt"));
    const result = propose(randomUUID());
    assert.equal(result.status, 0, result.stdout);
    const candidate = JSON.parse(result.stdout);
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.source_verification, "unverified");
    assert.equal(candidate.generation, 0);
    assert.equal(candidate.binding_generation, 1);
    assert.equal(candidate.intended_pane_id, "pane-r");
    assert.equal(candidate.turn, "ralph");
    assert.equal("content" in candidate, false);
    const dir = path.join(state, "host", "candidates", candidate.candidate_id);
    assert.equal(fs.readFileSync(path.join(dir, "content.txt"), "utf8"), "[PLAN] Review the task\n");
    assert.deepEqual(fs.readFileSync(path.join(state, "work.md")), workBefore);
    assert.deepEqual(fs.readFileSync(path.join(state, "turn.txt")), turnBefore);
    const view = JSON.parse(snapshot().stdout);
    assert.equal(view.candidate_count, 1);
    assert.equal(view.generation, 0);
    assert.equal(view.last_receipt_id, null);
    prepare(lease.lease_id);
  });

  it("returns an identical candidate on retry and rejects different content for one ID", () => {
    const lease = claim();
    bind(lease.lease_id);
    prepare(lease.lease_id);
    const id = randomUUID();
    const first = propose(id);
    assert.equal(first.status, 0, first.stdout);
    assert.deepEqual(JSON.parse(propose(id).stdout), JSON.parse(first.stdout));
    assert.deepEqual(JSON.parse(propose(id.toUpperCase()).stdout), JSON.parse(first.stdout));
    fs.writeFileSync(path.join(project, "proposal.md"), "[PLAN] Changed\n");
    const conflict = propose(id);
    assert.equal(conflict.status, 5);
    assert.equal(JSON.parse(conflict.stdout).code, "DUPLICATE_CONFLICT");
    assert.equal(JSON.parse(snapshot().stdout).candidate_count, 1);
  });

  it("requires the current turn, an active seat binding, and a prepared generation", () => {
    const lease = claim();
    const unbound = propose(randomUUID());
    assert.equal(unbound.status, 4);
    assert.equal(JSON.parse(unbound.stdout).code, "WRONG_SEAT");
    bind(lease.lease_id);
    const missingGeneration = propose(randomUUID());
    assert.equal(missingGeneration.status, 5);
    assert.equal(JSON.parse(missingGeneration.stdout).code, "GENERATION_REQUIRED");
    prepare(lease.lease_id);
    const wrongRole = propose(randomUUID(), "lisa");
    assert.equal(wrongRole.status, 4);
    assert.equal(JSON.parse(wrongRole.stdout).code, "WRONG_SEAT");
    assert.equal(JSON.parse(snapshot().stdout).candidate_count, 0);
  });

  it("rejects files outside the project, links, invalid UTF-8, and empty content", () => {
    const lease = claim();
    bind(lease.lease_id);
    prepare(lease.lease_id);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rll-candidate-outside-"));
    try {
      const externalFile = path.join(outside, "content.md");
      fs.writeFileSync(externalFile, "[PLAN] elsewhere\n");
      assert.equal(propose(randomUUID(), "ralph", externalFile).status, 2);
      const link = path.join(project, "linked.md");
      fs.symlinkSync(externalFile, link);
      assert.equal(propose(randomUUID(), "ralph", "linked.md").status, 2);
      fs.writeFileSync(path.join(project, "proposal.md"), Buffer.from([0xff, 0xfe]));
      assert.equal(propose(randomUUID()).status, 2);
      fs.writeFileSync(path.join(project, "proposal.md"), " \n");
      assert.equal(propose(randomUUID()).status, 2);
      assert.equal(JSON.parse(snapshot().stdout).candidate_count, 0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("freezes snapshots and lease release after an interrupted candidate write", () => {
    const lease = claim();
    bind(lease.lease_id);
    prepare(lease.lease_id);
    const root = path.join(project, ".dual-agent", "host", "candidates");
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, `${randomUUID()}.pending`));
    assert.equal(propose(randomUUID()).status, 7);
    assert.equal(snapshot().status, 7);
    assert.equal(run("host", "release", "--project", project, "--lease-id", lease.lease_id, "--json").status, 7);
  });

  it("detects changed candidate content and does not recover the lease over it", () => {
    const lease = claim();
    bind(lease.lease_id);
    prepare(lease.lease_id);
    const candidate = JSON.parse(propose(randomUUID()).stdout);
    const file = path.join(project, ".dual-agent", "host", "candidates", candidate.candidate_id, "content.txt");
    fs.appendFileSync(file, "tampered\n");
    assert.equal(snapshot().status, 7);
    assert.equal(run("host", "recovery-check", "--project", project, "--json").status, 7);
  });

  it("keeps candidates as historical evidence when explicitly recovering a lease", () => {
    const lease = claim();
    bind(lease.lease_id);
    prepare(lease.lease_id);
    const candidate = JSON.parse(propose(randomUUID()).stdout);
    const check = run("host", "recovery-check", "--project", project, "--json");
    assert.equal(check.status, 0, check.stdout);
    const plan = JSON.parse(check.stdout);
    assert.equal(plan.candidate_count, 1);
    const recovered = run("host", "recover-lease", "--project", project,
      "--lease-id", lease.lease_id, "--expected-evidence", plan.evidence_sha256,
      "--decision", "verified-stopped-no-replay", "--json");
    assert.equal(recovered.status, 0, recovered.stdout);
    assert.equal(JSON.parse(snapshot().stdout).candidate_count, 1);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "candidates", candidate.candidate_id)), true);
  });
});
