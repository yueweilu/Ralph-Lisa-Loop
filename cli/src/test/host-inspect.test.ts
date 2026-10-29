import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HostContractError, inspectProject } from "../host/inspect.js";

describe("host inspect", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-inspect-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function createSession(name: string): string {
    const project = path.join(root, name);
    const state = path.join(project, ".dual-agent");
    fs.mkdirSync(state, { recursive: true });
    const projectRealpath = fs.realpathSync.native(project);
    fs.writeFileSync(path.join(state, ".project_root"), projectRealpath);
    fs.writeFileSync(path.join(state, "turn.txt"), "ralph");
    fs.writeFileSync(path.join(state, "round.txt"), "1");
    fs.writeFileSync(path.join(state, "step.txt"), "planning");
    return projectRealpath;
  }

  it("requires an explicit absolute project path", () => {
    assert.throws(
      () => inspectProject("relative/project"),
      (error: unknown) => error instanceof HostContractError && error.code === "PROJECT_ABSOLUTE_REQUIRED"
    );
  });

  it("reports an uninitialized project without creating state", () => {
    const project = path.join(root, "empty");
    fs.mkdirSync(project);
    const result = inspectProject(project);
    assert.equal(result.initialized, false);
    assert.equal(result.contract_state, "absent");
    assert.equal(result.state_realpath, null);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent")), false);
  });

  it("reads one legacy project even when the process environment points elsewhere", () => {
    const first = createSession("first");
    const second = createSession("second");
    const original = process.env.RL_STATE_DIR;
    process.env.RL_STATE_DIR = path.join(second, ".dual-agent");
    try {
      const result = inspectProject(first);
      assert.equal(result.project_realpath, fs.realpathSync.native(first));
      assert.equal(result.contract_state, "legacy");
      assert.equal(result.turn, "ralph");
      assert.equal(result.round, 1);
      assert.equal(result.step, "planning");
    } finally {
      if (original === undefined) delete process.env.RL_STATE_DIR;
      else process.env.RL_STATE_DIR = original;
    }
  });

  it("rejects a state directory recorded for another project", () => {
    const first = createSession("first");
    const second = createSession("second");
    fs.writeFileSync(path.join(first, ".dual-agent", ".project_root"), second);
    assert.throws(
      () => inspectProject(first),
      (error: unknown) => error instanceof HostContractError && error.code === "PROJECT_MISMATCH"
    );
  });

  it("rejects a symlinked state directory", () => {
    const first = createSession("first");
    const second = path.join(root, "second");
    fs.mkdirSync(second);
    fs.symlinkSync(path.join(first, ".dual-agent"), path.join(second, ".dual-agent"), "dir");
    assert.throws(
      () => inspectProject(second),
      (error: unknown) => error instanceof HostContractError && error.code === "PROJECT_MISMATCH"
    );
  });

  it("rejects damaged state instead of using legacy defaults", () => {
    const project = createSession("damaged");
    fs.writeFileSync(path.join(project, ".dual-agent", "turn.txt"), "unknown");
    assert.throws(
      () => inspectProject(project),
      (error: unknown) => error instanceof HostContractError && error.code === "STATE_INVALID"
    );
  });

  it("flags incomplete host metadata for reconciliation", () => {
    const project = createSession("partial");
    fs.mkdirSync(path.join(project, ".dual-agent", "host"));
    assert.throws(
      () => inspectProject(project),
      (error: unknown) => error instanceof HostContractError && error.code === "NEEDS_RECONCILE"
    );
  });

  it("reads a matching identified session and rejects a mismatched one", () => {
    const project = createSession("identified");
    const sessionPath = path.join(project, ".dual-agent", "session.json");
    const sessionId = randomUUID();
    fs.writeFileSync(sessionPath, JSON.stringify({ schema: 1, session_id: sessionId, project_realpath: project, state_realpath: path.join(project, ".dual-agent") }));
    assert.equal(inspectProject(project).session_id, sessionId);
    fs.writeFileSync(sessionPath, JSON.stringify({ schema: 1, session_id: sessionId, project_realpath: root, state_realpath: path.join(project, ".dual-agent") }));
    assert.throws(
      () => inspectProject(project),
      (error: unknown) => error instanceof HostContractError && error.code === "PROJECT_MISMATCH"
    );
  });

  it("returns one JSON object from the CLI and does not follow cwd or RL_STATE_DIR", () => {
    const first = createSession("first");
    const second = createSession("second");
    const cli = path.join(__dirname, "..", "cli.js");
    const run = spawnSync(process.execPath, [cli, "host", "inspect", "--project", first, "--json"], {
      cwd: second,
      env: { ...process.env, RL_STATE_DIR: path.join(second, ".dual-agent") },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).project_realpath, first);
  });

  it("returns a structured nonzero CLI error for an invalid project argument", () => {
    const cli = path.join(__dirname, "..", "cli.js");
    const run = spawnSync(process.execPath, [cli, "host", "inspect", "--project", "relative", "--json"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 2);
    assert.equal(run.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(run.stdout).code, "PROJECT_ABSOLUTE_REQUIRED");
  });

  it("assigns a fresh stable session ID during normal minimal init", () => {
    const project = path.join(root, "new-session");
    fs.mkdirSync(project);
    const cli = path.join(__dirname, "..", "cli.js");
    const init = spawnSync(process.execPath, [cli, "init", "--minimal", project], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Minimal Init Complete/);

    const first = inspectProject(project);
    const second = inspectProject(project);
    assert.equal(first.contract_state, "identified");
    assert.match(first.session_id || "", /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.equal(first.session_id, second.session_id);
    assert.equal(first.project_realpath, fs.realpathSync.native(project));

    const reinit = spawnSync(process.execPath, [cli, "init", "--minimal", project], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(reinit.status, 0, reinit.stderr);
    assert.notEqual(inspectProject(project).session_id, first.session_id);
  });
});
