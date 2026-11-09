import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "start-task.mjs");

test("start-task refuses missing Herdr Workspace context", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", input: "Task\n",
    env: { ...process.env, HERDR_PLUGIN_CONTEXT_JSON: "", HERDR_WORKSPACE_ID: "" } });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /PROJECT_CONTEXT_INVALID/);
});

test("start-task refuses an existing session before asking for a task", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-start-task-"));
  const state = path.join(project, ".dual-agent");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "sentinel"), "unchanged");
  try {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", input: "",
      env: { ...process.env, HERDR_WORKSPACE_ID: "w1",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }) } });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stdout, /Ralph-Lisa project:/);
    assert.match(result.stdout, /Session: existing/);
    assert.match(result.stderr, /SESSION_EXISTS/);
    assert.equal(fs.readFileSync(path.join(state, "sentinel"), "utf8"), "unchanged");
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("start-task shows a preview and cancellation does not initialize a session", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-start-task-"));
  try {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, HERDR_WORKSPACE_ID: "w1",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }) } });
    let stdout = "", stderr = "", step = 0;
    const prompts = ["Task: ", "Agent permissions [interactive/full-auto]", "Start this task?"];
    const answers = ["Write a short README\n", "full-auto\n", "n\n"];
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (step < prompts.length && stdout.includes(prompts[step])) child.stdin.write(answers[step++]);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => child.kill(), 5000);
    const status = await new Promise((resolve) => child.once("close", resolve));
    clearTimeout(timeout);
    assert.equal(status, 3, stdout + stderr);
    assert.equal(step, 3);
    assert.match(stdout, /Session: new/);
    assert.match(stdout, /Task summary: Write a short README/);
    assert.match(stdout, /Agent permissions: full-auto/);
    assert.match(stdout, /Formal candidate commits: separate source confirmation required/);
    assert.match(stderr, /START_CANCELLED/);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent")), false);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test("start-task treats closed input as cancellation", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-start-task-"));
  try {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8",
      input: "Write a short README\n",
      env: { ...process.env, HERDR_WORKSPACE_ID: "w1",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", workspace_cwd: project }) } });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /START_CANCELLED/);
    assert.equal(fs.existsSync(path.join(project, ".dual-agent")), false);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
