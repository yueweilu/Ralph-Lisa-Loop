import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initSessionIfAbsent } from "../herdr/session-init.js";
import { acquireSessionCommandLock } from "../host/guard.js";

function project(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-init-")); }

describe("Herdr safe session initialization", () => {
  it("creates a complete session once without replacing it", () => {
    const dir = project();
    try {
      const release = acquireSessionCommandLock(path.join(dir, ".dual-agent"));
      const task = "Write a README";
      const id = initSessionIfAbsent(dir, task, crypto.randomUUID());
      release();
      const state = path.join(dir, ".dual-agent");
      assert.equal(fs.readFileSync(path.join(state, "turn.txt"), "utf8"), "ralph");
      assert.match(fs.readFileSync(path.join(state, "task.md"), "utf8"), /Write a README/);
      const identity = JSON.parse(fs.readFileSync(path.join(state, "session.json"), "utf8"));
      assert.equal(identity.session_id, id);
      assert.equal(identity.state_realpath, path.join(fs.realpathSync.native(dir), ".dual-agent"));
      assert.throws(() => initSessionIfAbsent(dir, "Different task", crypto.randomUUID()), /SESSION_EXISTS/);
      assert.equal(fs.readFileSync(path.join(state, "task.md"), "utf8").includes("Different task"), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("stops when incomplete initialization remains", () => {
    const dir = project();
    try {
      fs.mkdirSync(path.join(dir, `.dual-agent.init-${crypto.randomUUID()}`));
      assert.throws(() => initSessionIfAbsent(dir, "Task", crypto.randomUUID()), /INIT_REQUIRES_REVIEW/);
      assert.equal(fs.existsSync(path.join(dir, ".dual-agent")), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects an existing state symlink", () => {
    const dir = project();
    const other = project();
    try {
      fs.symlinkSync(other, path.join(dir, ".dual-agent"));
      assert.throws(() => initSessionIfAbsent(dir, "Task", crypto.randomUUID()), /SESSION_EXISTS/);
      assert.deepEqual(fs.readdirSync(other), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
