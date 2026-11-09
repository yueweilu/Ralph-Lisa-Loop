import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createLaunchIntent, recordLaunchWorkspace } from "../herdr/launch-record.js";
import { inspectHerdrLaunch } from "../herdr/launch-status.js";
import { initSessionIfAbsent } from "../herdr/session-init.js";

describe("read-only Herdr launch status", () => {
  it("reports evidence without inventing an active host", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-launch-status-"));
    try {
      const request = crypto.randomUUID();
      const session = initSessionIfAbsent(project, "Write a README", request);
      createLaunchIntent(project, session, request, false);
      const pending = inspectHerdrLaunch(project) as Record<string, unknown>;
      assert.equal(pending.status, "pending");
      assert.equal(pending.request_id, request);
      assert.equal(pending.host_state, "unclaimed");
      assert.equal(pending.workspace_id, null);
      const cli = spawnSync(process.execPath,
        [path.resolve(__dirname, "../herdr-rll.js"), "status", "--project", project],
        { encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).status, "pending");
      recordLaunchWorkspace(project, request, "w1", "w1:p1", "term-r");
      fs.writeFileSync(path.join(project, ".dual-agent", "herdr-launch-result.json"),
        JSON.stringify({ schema: 1, request_id: request, status: "started" }));
      const stopped = inspectHerdrLaunch(project) as Record<string, unknown>;
      assert.equal(stopped.status, "needs_review");
      assert.equal(stopped.launch_result, "started");
      assert.equal(stopped.host_state, "unclaimed");
      fs.appendFileSync(path.join(project, ".dual-agent", "task.md"), "Tampered");
      assert.throws(() => inspectHerdrLaunch(project), /LAUNCH_INTENT_MISMATCH/);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });

  it("refuses a project without an identified Herdr request", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-launch-status-"));
    try { assert.throws(() => inspectHerdrLaunch(project), /HERDR_SESSION_NOT_FOUND/); }
    finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
