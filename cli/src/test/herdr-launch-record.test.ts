import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initSessionIfAbsent } from "../herdr/session-init.js";
import { createLaunchIntent, readLaunchIntent, readLaunchWorkspace, recordLaunchWorkspace } from "../herdr/launch-record.js";

describe("Herdr immutable launch records", () => {
  it("binds a request to formal task, session and one Workspace", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-launch-"));
    try {
      const request = crypto.randomUUID();
      const session = initSessionIfAbsent(project, "Write a README", request);
      const intent = createLaunchIntent(project, session, request, false);
      assert.equal(intent.auto_commit, false);
      assert.equal(intent.permission_profile, "interactive");
      assert.equal(readLaunchIntent(project, request).session_id, session);
      const workspace = recordLaunchWorkspace(project, request, "w1", "w1:p1", "t1");
      assert.deepEqual(readLaunchWorkspace(project, request), workspace);
      assert.throws(() => recordLaunchWorkspace(project, request, "w2", "w2:p1", "t2"), /EEXIST/);
      fs.appendFileSync(path.join(project, ".dual-agent", "task.md"), "Changed");
      assert.throws(() => readLaunchIntent(project, request), /LAUNCH_INTENT_MISMATCH/);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
