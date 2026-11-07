import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "start-task.mjs");

test("start-task refuses missing Herdr Workspace context", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", input: "Task\n",
    env: { ...process.env, HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_WORKSPACE_ID: "" } });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /PROJECT_CONTEXT_INVALID/);
});

test("start-task forwards the selected project and preserves an existing session", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-start-task-"));
  const state = path.join(project, ".dual-agent");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "sentinel"), "unchanged");
  try {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", input: "New task\n",
      env: { ...process.env, HERDR_WORKSPACE_ID: "w1",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }) } });
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.match(result.stdout, /Ralph-Lisa project:/);
    assert.match(result.stderr, /SESSION_EXISTS/);
    assert.equal(fs.readFileSync(path.join(state, "sentinel"), "utf8"), "unchanged");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
