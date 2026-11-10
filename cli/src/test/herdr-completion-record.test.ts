import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasCompletedArchive } from "../herdr/completion-record.js";
import type { HostSnapshot } from "../host/snapshot.js";
import type { LaunchIntent, LaunchWorkspace } from "../herdr/launch-record.js";

describe("Herdr archived completion status", () => {
  it("accepts only the matching completed archive and released final host cursor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rll-completion-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(root, "state");
    try {
      const project = path.join(root, "project");
      fs.mkdirSync(project);
      const request = crypto.randomUUID();
      const session = crypto.randomUUID();
      const owner = crypto.randomUUID();
      const receipt = crypto.randomUUID();
      const digest = "a".repeat(64);
      const intent: LaunchIntent = { schema: 1, request_id: request,
        project_realpath: project, session_id: session, task_sha256: "b".repeat(64),
        permission_profile: "full_auto", auto_commit: true,
        auto_commit_granted_via: "cli_auto_host_herdr" };
      const workspace: LaunchWorkspace = { schema: 1, request_id: request,
        workspace_id: "w1", root_pane_id: "w1:p1", root_terminal_id: "term-r" };
      const host: HostSnapshot = { schema: 1, status: "ok", project_realpath: project,
        state_realpath: path.join(project, ".dual-agent"), session_id: session,
        turn: "ralph", round: 2, step: "planning", host_state: "unclaimed",
        owner_id: null, state_digest: digest, generation: 2, binding_generation: 1,
        binding_state: "stale", workspace_id: null, seats: null,
        last_receipt_id: receipt, candidate_count: 2 };
      const key = crypto.createHash("sha256").update(project).digest("hex");
      const dir = path.join(process.env.XDG_STATE_HOME!, "herdr", "plugins",
        "ralph-lisa.loop", "sessions", key);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `finished-${owner}.json`);
      const record = { phase: "completed", owner_id: owner, auto_commit: true,
        initial_status: "accepted", launch_request_id: request,
        project_realpath: project, session_id: session, workspace_id: "w1",
        cursor_generation: 2, cursor_receipt_id: receipt, cursor_turn: "ralph",
        completion_state_digest: digest, completed_at: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(record));
      assert.equal(hasCompletedArchive(intent, workspace, host), true);
      assert.equal(hasCompletedArchive({ ...intent, auto_commit: false }, workspace, host), false);
      assert.equal(hasCompletedArchive(intent, { ...workspace, workspace_id: "w2" }, host), false);
      assert.equal(hasCompletedArchive(intent, workspace, { ...host, generation: 3 }), false);
      assert.equal(hasCompletedArchive(intent, workspace,
        { ...host, host_state: "claimed", binding_state: "bound" }), false);
      fs.writeFileSync(file, JSON.stringify({ ...record, launch_request_id: crypto.randomUUID() }));
      assert.equal(hasCompletedArchive(intent, workspace, host), false);
      fs.writeFileSync(file, "null");
      assert.equal(hasCompletedArchive(intent, workspace, host), false);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
