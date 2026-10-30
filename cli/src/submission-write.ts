/** Prepare exact business changes before writing, then apply the same plan. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  extractSummary, formatHistoryEntry, formatLastAction, getRound, getStep,
  readFile, stateDir, timeShort, timestamp,
} from "./state.js";

export type SubmissionWriteEvent =
  | { type: "tests_cleaned" }
  | { type: "deadlock"; count: number };

export interface SubmissionWriteOptions {
  content: string;
  external: boolean;
  tag: string;
  projectDir?: string;
  onEvent?: (event: SubmissionWriteEvent) => void;
}

export interface SubmissionWriteResult {
  round: string;
  step: string;
  summary: string;
  turnAfter: "ralph" | "lisa";
  roundAfter: number;
  testsCleaned: boolean;
  deadlockCount: number | null;
}

export interface PlannedFileChange {
  name: string;
  action: "write" | "delete" | "remove_tree";
  before_sha256: string | null;
  after_sha256: string | null;
  /** In-memory bytes only; a durable intent should persist hashes, not message content. */
  after_bytes?: Buffer;
  event?: SubmissionWriteEvent;
}

export interface SubmissionWritePlan {
  stateDir: string;
  changes: PlannedFileChange[];
  result: SubmissionWriteResult;
}

const WRITABLE_FILES = new Set([
  "work.md", "review.md", "history.md", "last_action.txt", "turn.txt",
  "round.txt", "needs_work_count.txt", "deadlock.txt",
]);

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileBytes(file: string): Buffer | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid submission file: ${file}`);
  return fs.readFileSync(file);
}

/** Include names, types and bytes so a cleanup cannot silently drop changed evidence. */
function treeDigest(root: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const hash = crypto.createHash("sha256");
  const visit = (file: string, name: string, info: fs.Stats): void => {
    if (info.isSymbolicLink()) {
      hash.update("link\0").update(name).update("\0").update(fs.readlinkSync(file)).update("\0");
    } else if (info.isFile()) {
      const bytes = fs.readFileSync(file);
      hash.update("file\0").update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
    } else if (info.isDirectory()) {
      hash.update("dir\0").update(name).update("\0");
      for (const child of fs.readdirSync(file).sort()) {
        visit(path.join(file, child), `${name}/${child}`, fs.lstatSync(path.join(file, child)));
      }
    } else {
      throw new Error(`Invalid submission evidence: ${file}`);
    }
  };
  visit(root, ".", stat);
  return hash.digest("hex");
}

function getFilesChanged(projectDir?: string): string[] {
  try {
    const output = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only", {
      cwd: projectDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function makeBuilder(dir: string) {
  const changes: PlannedFileChange[] = [];
  const addWrite = (name: string, content: string | Buffer, event?: SubmissionWriteEvent): void => {
    const before = fileBytes(path.join(dir, name));
    const after = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    changes.push({ name, action: "write", before_sha256: before && sha256(before),
      after_sha256: sha256(after), after_bytes: after, event });
  };
  const addDelete = (name: string): void => {
    const before = fileBytes(path.join(dir, name));
    if (before) changes.push({ name, action: "delete", before_sha256: sha256(before), after_sha256: null });
  };
  const addTreeDelete = (name: string): boolean => {
    const before = treeDigest(path.join(dir, name));
    if (!before) return false;
    changes.push({ name, action: "remove_tree", before_sha256: before, after_sha256: null,
      event: { type: "tests_cleaned" } });
    return true;
  };
  return { changes, addWrite, addDelete, addTreeDelete };
}

/** Caller must hold the project write lock and complete turn, policy and gate checks. */
export function prepareRalphSubmission(options: SubmissionWriteOptions): SubmissionWritePlan {
  const { content, external, tag, projectDir } = options;
  const dir = stateDir(projectDir);
  const round = getRound(projectDir);
  const step = getStep(projectDir);
  const ts = timestamp();
  const summary = extractSummary(content);
  const builder = makeBuilder(dir);

  const taskFile = readFile(path.join(dir, "task.md"));
  const taskLines = taskFile.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("Created:") && !l.startsWith("Updated:"));
  const taskContext = taskLines[taskLines.length - 1] || "";
  let filesChangedSection = "";
  if (tag === "CODE" || tag === "FIX") {
    const files = getFilesChanged(projectDir);
    if (files.length > 0) filesChangedSection = `**Files Changed**:\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }

  let contextSection = "";
  const contextPath = path.join(dir, "context.md");
  if (fs.existsSync(contextPath)) {
    const ctxContent = readFile(contextPath);
    if (ctxContent && !ctxContent.includes("(visible to Lisa).\n\n\n")) {
      const ctxLines = ctxContent.split("\n").filter((l) => l.startsWith("- ["));
      if (ctxLines.length > 0) contextSection = `**Context**: ${ctxLines.join("; ")}\n`;
    }
  }

  const taskLine = taskContext ? `**Task**: ${taskContext}\n` : "";
  builder.addWrite("work.md",
    `# Ralph Work\n\n## [${tag}] Round ${round} | Step: ${step}\n${taskLine}${contextSection}**Updated**: ${ts}\n**Summary**: ${summary}\n${filesChangedSection ? "\n" + filesChangedSection : "\n"}${content}\n`);
  const historyContent = external ? `[${tag}] ${summary}\n\n(Full content in work.md)` : content;
  const historyBefore = fileBytes(path.join(dir, "history.md")) || Buffer.alloc(0);
  builder.addWrite("history.md", Buffer.concat([historyBefore,
    Buffer.from(formatHistoryEntry("Ralph", historyContent, round, step, timestamp()))]));
  builder.addWrite("last_action.txt", formatLastAction("Ralph", content, timeShort()));
  builder.addWrite("turn.txt", "lisa");
  const testsCleaned = tag === "CONSENSUS" ? builder.addTreeDelete("tests") : false;
  return { stateDir: dir, changes: builder.changes,
    result: { round, step, summary, turnAfter: "lisa", roundAfter: parseInt(round, 10) || 0,
      testsCleaned, deadlockCount: null } };
}

/** Caller must hold the project write lock and complete turn and policy checks. */
export function prepareLisaSubmission(options: SubmissionWriteOptions): SubmissionWritePlan {
  const { content, external, tag, projectDir } = options;
  const dir = stateDir(projectDir);
  const round = getRound(projectDir);
  const step = getStep(projectDir);
  const ts = timestamp();
  const summary = extractSummary(content);
  const builder = makeBuilder(dir);

  const newEntry = `## [${tag}] Round ${round} | Step: ${step}\n**Updated**: ${ts}\n**Summary**: ${summary}\n\n${content}`;
  const existing = readFile(path.join(dir, "review.md"));
  const REVIEW_SEP = "\n\n---\n\n";
  let entries: string[] = [];
  if (existing && !existing.startsWith("# Lisa Review\n\n(Waiting")) {
    const body = existing.replace(/^# Lisa Review\n\n/, "");
    entries = body.split(REVIEW_SEP).filter((e) => e.trim());
  }
  entries.push(newEntry);
  if (entries.length > 3) entries = entries.slice(-3);
  builder.addWrite("review.md", `# Lisa Review\n\n${entries.join(REVIEW_SEP)}\n`);

  const historyContent = external ? `[${tag}] ${summary}\n\n(Full content in review.md)` : content;
  const historyBefore = fileBytes(path.join(dir, "history.md")) || Buffer.alloc(0);
  builder.addWrite("history.md", Buffer.concat([historyBefore,
    Buffer.from(formatHistoryEntry("Lisa", historyContent, round, step, timestamp()))]));
  builder.addWrite("last_action.txt", formatLastAction("Lisa", content, timeShort()));
  builder.addWrite("turn.txt", "ralph");

  let deadlockCount: number | null = null;
  if (tag === "NEEDS_WORK") {
    const newCount = parseInt(readFile(path.join(dir, "needs_work_count.txt")) || "0", 10) + 1;
    builder.addWrite("needs_work_count.txt", String(newCount));
    const threshold = parseInt(process.env.RL_DEADLOCK_THRESHOLD || "8", 10);
    if (newCount >= threshold) {
      builder.addWrite("deadlock.txt",
        `DEADLOCK at round ${round}: ${newCount} consecutive NEEDS_WORK rounds\nTimestamp: ${ts}\nAction: Watcher will pause. User intervention required.`,
        { type: "deadlock", count: newCount });
      deadlockCount = newCount;
    }
  } else {
    builder.addWrite("needs_work_count.txt", "0");
    builder.addDelete("deadlock.txt");
  }

  const testsCleaned = tag === "CONSENSUS" ? builder.addTreeDelete("tests") : false;
  const roundAfter = (parseInt(round, 10) || 0) + 1;
  builder.addWrite("round.txt", String(roundAfter));
  return { stateDir: dir, changes: builder.changes,
    result: { round, step, summary, turnAfter: "ralph", roundAfter, testsCleaned, deadlockCount } };
}

function currentDigest(file: string, action: PlannedFileChange["action"]): string | null {
  if (action === "remove_tree") return treeDigest(file);
  const bytes = fileBytes(file);
  return bytes ? sha256(bytes) : null;
}

/** Recheck every pre-state before the first mutation; never regenerate a plan on retry. */
export function applySubmissionPlan(
  plan: SubmissionWritePlan, onEvent?: (event: SubmissionWriteEvent) => void
): SubmissionWriteResult {
  for (const change of plan.changes) {
    if ((change.action === "write" && !WRITABLE_FILES.has(change.name)) ||
        (change.action === "delete" && change.name !== "deadlock.txt") ||
        (change.action === "remove_tree" && change.name !== "tests") ||
        (change.action !== "write" && change.after_sha256 !== null) ||
        (change.action === "write" && (!change.after_bytes ||
          sha256(change.after_bytes) !== change.after_sha256))) {
      throw new Error(`Invalid submission plan change: ${change.name}`);
    }
    if (currentDigest(path.join(plan.stateDir, change.name), change.action) !== change.before_sha256) {
      throw new Error(`Submission state changed before applying ${change.name}`);
    }
  }
  for (const change of plan.changes) {
    const file = path.join(plan.stateDir, change.name);
    if (change.action === "write") {
      if (!change.after_bytes) throw new Error(`Missing planned content for ${change.name}`);
      fs.writeFileSync(file, change.after_bytes);
    } else if (change.action === "delete") {
      fs.unlinkSync(file);
    } else {
      fs.rmSync(file, { recursive: true, force: true });
    }
    if (currentDigest(file, change.action) !== change.after_sha256) {
      throw new Error(`Submission write did not match plan for ${change.name}`);
    }
    if (change.event) onEvent?.(change.event);
  }
  return plan.result;
}

export function applyRalphSubmission(options: SubmissionWriteOptions): SubmissionWriteResult {
  return applySubmissionPlan(prepareRalphSubmission(options), options.onEvent);
}

export function applyLisaSubmission(options: SubmissionWriteOptions): SubmissionWriteResult {
  return applySubmissionPlan(prepareLisaSubmission(options), options.onEvent);
}
