import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

describe("legacy host adoption", () => {
  let project: string;
  const cli = path.join(__dirname, "..", "cli.js");

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
  }

  function adopt() {
    return run("host", "adopt", "--project", project, "--json");
  }

  function confirm(backupId: string, decision = "no-replay") {
    return run("host", "confirm-adoption", "--project", project,
      "--backup-id", backupId, "--decision", decision, "--json");
  }

  beforeEach(() => {
    project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-adopt-")));
    assert.equal(run("init", "--minimal", project).status, 0);
    fs.unlinkSync(path.join(project, ".dual-agent", "session.json"));
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("backs up the old state, freezes replay, and confirms without changing business files", () => {
    const state = path.join(project, ".dual-agent");
    fs.writeFileSync(path.join(state, "turn.txt"), "lisa\n");
    const workBefore = fs.readFileSync(path.join(state, "work.md"));
    const turnBefore = fs.readFileSync(path.join(state, "turn.txt"));
    const result = adopt();
    assert.equal(result.status, 0, result.stdout);
    const adoption = JSON.parse(result.stdout);
    assert.equal(adoption.status, "pending_review");
    assert.equal(adoption.turn, "lisa");
    assert.equal(adoption.replay, "blocked");
    const backup = path.join(project, adoption.backup_relative_path);
    assert.deepEqual(fs.readFileSync(path.join(backup, "work.md")), workBefore);
    assert.deepEqual(fs.readFileSync(path.join(backup, "turn.txt")), turnBefore);
    assert.deepEqual(fs.readFileSync(path.join(state, "work.md")), workBefore);
    assert.deepEqual(fs.readFileSync(path.join(state, "turn.txt")), turnBefore);
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
    assert.equal(run("submit-lisa", "[PASS] old round").status, 4);
    assert.equal(run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", randomUUID(), "--json").status, 4);

    const wrong = confirm(randomUUID());
    assert.equal(wrong.status, 4);
    assert.equal(JSON.parse(wrong.stdout).code, "ADOPTION_MISMATCH");
    assert.equal(confirm(adoption.backup_id, "replay").status, 2);
    const approved = confirm(adoption.backup_id);
    assert.equal(approved.status, 0, approved.stdout);
    assert.equal(JSON.parse(approved.stdout).replay, "not_replayed");
    assert.deepEqual(JSON.parse(confirm(adoption.backup_id).stdout), JSON.parse(approved.stdout));
    assert.equal(fs.existsSync(path.join(state, "host", "reconcile.json")), false);
    assert.deepEqual(fs.readFileSync(path.join(state, "turn.txt")), turnBefore);
    const snapshot = run("host", "snapshot", "--project", project, "--json");
    assert.equal(snapshot.status, 0, snapshot.stdout);
    assert.equal(JSON.parse(snapshot.stdout).turn, "lisa");
    assert.equal(run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", randomUUID(), "--json").status, 0);
  });

  it("refuses an active tmux session before creating host metadata", () => {
    const bin = path.join(project, "bin");
    fs.mkdirSync(bin);
    const tmux = path.join(bin, "tmux");
    fs.writeFileSync(tmux, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(tmux, 0o755);
    const result = spawnSync(process.execPath, [cli, "host", "adopt", "--project", project, "--json"], {
      cwd: project, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` }, encoding: "utf8",
    });
    assert.equal(result.status, 4);
    assert.equal(JSON.parse(result.stdout).code, "HOST_BUSY");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host")), false);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "session.json")), false);
  });

  it("keeps the review marker when business state changes after backup", () => {
    const adoption = JSON.parse(adopt().stdout);
    const state = path.join(project, ".dual-agent");
    fs.appendFileSync(path.join(state, "work.md"), "manual change\n");
    const result = confirm(adoption.backup_id);
    assert.equal(result.status, 7);
    assert.equal(JSON.parse(result.stdout).code, "NEEDS_RECONCILE");
    assert.equal(fs.existsSync(path.join(state, "host", "reconcile.json")), true);
    assert.equal(fs.existsSync(path.join(state, "host", "adoption-backups", adoption.backup_id, "work.md")), true);
  });

  it("keeps the review marker when its backup changes", () => {
    const adoption = JSON.parse(adopt().stdout);
    fs.appendFileSync(path.join(project, adoption.backup_relative_path, "task.md"), "tampered\n");
    const result = confirm(adoption.backup_id);
    assert.equal(result.status, 7);
    assert.equal(JSON.parse(result.stdout).code, "NEEDS_RECONCILE");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "reconcile.json")), true);
  });

  it("stays frozen if the review marker is missing but adoption is pending", () => {
    const adoption = JSON.parse(adopt().stdout);
    const host = path.join(project, ".dual-agent", "host");
    fs.unlinkSync(path.join(host, "reconcile.json"));
    assert.equal(run("submit-ralph", "[PLAN] blocked").status, 4);
    const claim = run("host", "claim", "--project", project, "--host", "herdr", "--owner-id", randomUUID(), "--json");
    assert.equal(claim.status, 7);
    assert.equal(JSON.parse(claim.stdout).code, "NEEDS_RECONCILE");
    assert.equal(run("host", "snapshot", "--project", project, "--json").status, 7);
    assert.equal(confirm(adoption.backup_id).status, 7);
  });

  it("requires a stopped tmux session when confirming the old turn", () => {
    const adoption = JSON.parse(adopt().stdout);
    const bin = path.join(project, "bin");
    fs.mkdirSync(bin);
    const tmux = path.join(bin, "tmux");
    fs.writeFileSync(tmux, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(tmux, 0o755);
    const blocked = spawnSync(process.execPath, [cli, "host", "confirm-adoption", "--project", project,
      "--backup-id", adoption.backup_id, "--decision", "no-replay", "--json"], {
      cwd: project, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` }, encoding: "utf8",
    });
    assert.equal(blocked.status, 4);
    assert.equal(JSON.parse(blocked.stdout).code, "HOST_BUSY");
    assert.equal(fs.existsSync(path.join(project, ".dual-agent", "host", "reconcile.json")), true);
  });

  it("does not overwrite an incomplete earlier migration", () => {
    const state = path.join(project, ".dual-agent");
    fs.mkdirSync(path.join(state, "host"));
    fs.writeFileSync(path.join(state, "host", "reconcile.json"), "{}\n");
    const result = adopt();
    assert.equal(result.status, 7);
    assert.equal(JSON.parse(result.stdout).code, "NEEDS_RECONCILE");
    assert.equal(fs.existsSync(path.join(state, "session.json")), false);
    assert.equal(run("init", "--minimal", project).status, 4);
  });
});
