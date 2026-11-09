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
  let hasSession = false;
  try { fs.lstatSync(path.join(project, ".dual-agent")); hasSession = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (hasSession) {
    process.stdout.write("Session: existing. Inspect or resume it before starting another task.\n");
    throw new Error("SESSION_EXISTS");
  }
  process.stdout.write("Session: new. Agent turns follow formal RLL receipts.\n");
  process.stdout.write("Candidate commits require separate source confirmation.\n");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let task, fullAuto;
  try {
    task = (await input.question("Task: ")).trim();
    if (!task) throw new Error("TASK_REQUIRED");
    const permission = (await input.question("Agent permissions [interactive/full-auto] (default interactive): ")).trim().toLowerCase();
    if (permission && permission !== "interactive" && permission !== "full-auto")
      throw new Error("PERMISSION_PROFILE_INVALID");
    fullAuto = permission === "full-auto";
    const normalized = [...task.replace(/\s+/g, " ")];
    process.stdout.write(`Task summary: ${normalized.slice(0, 120).join("")}${normalized.length > 120 ? "…" : ""}\n`);
    process.stdout.write(`Agent permissions: ${fullAuto ? "full-auto" : "interactive"}\n`);
    process.stdout.write("Formal candidate commits: separate source confirmation required\n");
    const confirmed = (await input.question("Start this task? [y/N]: ")).trim().toLowerCase();
    if (confirmed !== "y" && confirmed !== "yes") throw new Error("START_CANCELLED");
  }
  finally { input.close(); }
  const env = { ...process.env, RLL_HERDR_REUSE_WORKSPACE_ID: context.workspace_id };
  delete env.RLL_HERDR_SESSION;
  const cli = path.resolve(root, "../../cli/dist/herdr-rll.js");
  const child = spawn(process.execPath, [cli, "--project", project,
    ...(fullAuto ? ["--full-auto"] : []), task],
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
