import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.join(__dirname, "..", "cli.js");

const cases = [
  { name: "before first business write", fault: "task", audit: "before", generation: 0,
    receipt: false },
  { name: "between task and history writes", fault: "history", audit: "partial", generation: 0,
    receipt: false },
  { name: "after generation but before receipt", fault: "receipt", audit: "applied", generation: 1,
    receipt: false },
  { name: "after receipt but before intent archive", fault: "archive", audit: "applied", generation: 1,
    receipt: true },
] as const;

describe("actual task-update writer fault points", () => {
  for (const scenario of cases) it(scenario.name, () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-task-fault-")));
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8" });
    const run = (...args: string[]) => {
      const result = invoke(...args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    try {
      assert.equal(invoke("init", "--minimal", project).status, 0);
      const state = path.join(project, ".dual-agent");
      const host = path.join(state, "host");
      const lease = run("host", "claim", "--project", project, "--host", "herdr",
        "--owner-id", crypto.randomUUID(), "--json");
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
      const taskFile = path.join(project, "new-task.txt");
      const body = "Build an updated page.\n";
      fs.writeFileSync(taskFile, body);
      const hash = crypto.createHash("sha256").update(body).digest("hex");
      const args = ["--project", project, "--lease-id", lease.lease_id,
        "--request-id", requestId, "--expected-generation", "0",
        "--expected-binding-generation", String(binding.binding_generation),
        "--expected-digest", before.state_digest, "--mode", "switch",
        "--file", taskFile, "--content-sha256", hash, "--json"];
      assert.equal(run("host", "task-update-check", ...args).status, "ready");

      const faultFile = path.join(project, "fault.cjs");
      fs.writeFileSync(faultFile, [
        "const fs = require('node:fs');",
        "const originalOpen = fs.openSync;",
        "const originalRename = fs.renameSync;",
        "let armed = false;",
        "fs.openSync = function(file, flags, ...rest) {",
        "  if (armed && process.env.RLL_FAULT_KIND === 'open' &&",
        "      String(file) === process.env.RLL_FAULT_PATH)",
        "    throw new Error('INJECTED_TASK_WRITE_FAILURE');",
        "  return originalOpen.call(this, file, flags, ...rest);",
        "};",
        "fs.renameSync = function(source, target) {",
        "  if (process.env.RLL_FAULT_KIND === 'rename' && String(source) === process.env.RLL_FAULT_PATH)",
        "    throw new Error('INJECTED_TASK_ARCHIVE_FAILURE');",
        "  const result = originalRename.call(this, source, target);",
        "  if (String(source) === process.env.RLL_INTENT_PENDING &&",
        "      String(target) === process.env.RLL_INTENT_FINAL) armed = true;",
        "  return result;",
        "};",
      ].join("\n") + "\n");
      const faultPath = scenario.fault === "task" ? path.join(state, "task.md") :
        scenario.fault === "history" ? path.join(state, "history.md") :
        scenario.fault === "receipt" ? path.join(host, "task-update-receipts",
          `${requestId}.pending`) :
          path.join(host, "task-update-intents", `${requestId}.json`);
      const failed = spawnSync(process.execPath,
        ["--require", faultFile, cli, "host", "task-update", ...args], {
          cwd: project, encoding: "utf8", env: { ...process.env,
            RLL_FAULT_KIND: scenario.fault === "archive" ? "rename" : "open",
            RLL_FAULT_PATH: faultPath,
            RLL_INTENT_PENDING: path.join(host, "task-update-intents", `${requestId}.pending`),
            RLL_INTENT_FINAL: path.join(host, "task-update-intents", `${requestId}.json`) },
        });
      assert.equal(failed.status, 7, failed.stdout + failed.stderr);
      assert.equal(JSON.parse(failed.stdout).code, "NEEDS_RECONCILE", failed.stdout + failed.stderr);
      assert.equal(fs.existsSync(path.join(host, "task-update-intents", `${requestId}.json`)), true);
      assert.equal(fs.existsSync(path.join(host, "task-update-receipts", `${requestId}.json`)),
        scenario.receipt);
      assert.equal(JSON.parse(fs.readFileSync(path.join(host, "generation.json"), "utf8"))
        .generation, scenario.generation);
      const lookup = invoke("host", "receipt", "--project", project,
        "--request-id", requestId, "--json");
      assert.equal(lookup.status, 7, lookup.stdout + lookup.stderr);
      const evidence = JSON.parse(lookup.stdout);
      assert.equal(evidence.status, "needs_reconcile");
      assert.equal(evidence.task_update_intent.audit_status, scenario.audit);
      assert.equal(evidence.task_update_intent.content_sha256, hash);
      assert.equal(invoke("host", "task-update-check", ...args).status, 7);
      assert.equal(invoke("host", "snapshot", "--project", project, "--json").status, 7);
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  });
});
