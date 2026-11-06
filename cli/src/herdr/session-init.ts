import * as fs from "node:fs";
import * as path from "node:path";
import { writeSessionIdentity } from "../host/session.js";
import { timestamp } from "../state.js";

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Shared file layout for the legacy init command and the non-destructive Herdr path. */
export function writeInitialSessionFiles(project: string, dir: string, task: string, finalStatePath?: string): string {
  const write = (name: string, value: string) => {
    const fd = fs.openSync(path.join(dir, name), "wx", 0o600);
    try { fs.writeFileSync(fd, value, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const ts = timestamp();
  write("task.md", `# Task\n\n${task}\n\n---\nCreated: ${ts}\n`);
  write("round.txt", "1");
  write("step.txt", "planning");
  write("turn.txt", "ralph");
  write(".project_root", project);
  write("last_action.txt", "(No action yet)");
  write("plan.md", "# Plan\n\n(To be drafted by Ralph and reviewed by Lisa)\n");
  write("work.md", "# Ralph Work\n\n(Waiting for Ralph to submit)\n");
  write("review.md", "# Lisa Review\n\n(Waiting for Lisa to respond)\n");
  write("history.md", `# Collaboration History\n\n**Task**: ${task}\n**Started**: ${ts}\n`);
  return writeSessionIdentity(project, dir, finalStatePath);
}

/** Only call while holding the project's RLL command lock. Never replaces state. */
export function initSessionIfAbsent(project: string, task: string, requestId: string): string {
  if (!task.trim()) throw new Error("TASK_REQUIRED");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))
    throw new Error("REQUEST_ID_INVALID");
  const real = fs.realpathSync.native(project);
  if (!fs.statSync(real).isDirectory()) throw new Error("PROJECT_NOT_DIRECTORY");
  const target = path.join(real, ".dual-agent");
  if (exists(target)) throw new Error("SESSION_EXISTS");
  const leftovers = fs.readdirSync(real).filter((name) => name.startsWith(".dual-agent.init-"));
  if (leftovers.length) throw new Error("INIT_REQUIRES_REVIEW");
  const staged = path.join(real, `.dual-agent.init-${requestId}`);
  fs.mkdirSync(staged, { mode: 0o700 });
  try {
    const sessionId = writeInitialSessionFiles(real, staged, task, target);
    const fd = fs.openSync(staged, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (exists(target)) throw new Error("SESSION_EXISTS");
    fs.renameSync(staged, target);
    const parentFd = fs.openSync(real, "r");
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    return sessionId;
  } catch (error) {
    // Keep staged state for inspection after any failed write or rename.
    throw error;
  }
}
