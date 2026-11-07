import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  let context;
  try { context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "null"); }
  catch { throw new Error("PROJECT_CONTEXT_INVALID"); }
  if (!context?.workspace_id || context.workspace_id !== process.env.HERDR_WORKSPACE_ID ||
      typeof context.workspace_cwd !== "string" || !path.isAbsolute(context.workspace_cwd))
    throw new Error("PROJECT_CONTEXT_INVALID");
  const project = fs.realpathSync.native(context.workspace_cwd);
  if (!fs.statSync(project).isDirectory()) throw new Error("PROJECT_CONTEXT_INVALID");
  process.stdout.write(`Ralph-Lisa project: ${project}\n`);
  process.stdout.write("Agent turns will follow formal RLL receipts. Candidate commits still require source confirmation.\n");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let task;
  try { task = (await input.question("Task: ")).trim(); }
  finally { input.close(); }
  if (!task) throw new Error("TASK_REQUIRED");
  const env = { ...process.env, RLL_HERDR_REUSE_WORKSPACE_ID: context.workspace_id };
  delete env.RLL_HERDR_SESSION;
  const cli = path.resolve(root, "../../cli/dist/herdr-rll.js");
  const child = spawn(process.execPath, [cli, "--project", project, task],
    { env, cwd: root, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message : "START_TASK_FAILED";
  process.stderr.write(`Ralph-Lisa start: ${code}\n`);
  process.exitCode = 3;
});
