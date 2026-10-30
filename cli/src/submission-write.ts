/** Existing Ralph/Lisa business writes shared by manual CLI and future host commit. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  appendHistory, extractSummary, getRound, getStep, readFile, setRound,
  setTurn, stateDir, timestamp, updateLastAction, writeFile,
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

function getFilesChanged(projectDir?: string): string[] {
  try {
    const output = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cleanTests(dir: string, onEvent?: SubmissionWriteOptions["onEvent"]): boolean {
  const testsDir = path.join(dir, "tests");
  if (!fs.existsSync(testsDir)) return false;
  fs.rmSync(testsDir, { recursive: true, force: true });
  onEvent?.({ type: "tests_cleaned" });
  return true;
}

/** Call only after turn/policy/gate validation and under the caller's write protection. */
export function applyRalphSubmission(options: SubmissionWriteOptions): SubmissionWriteResult {
  const { content, external, tag, projectDir, onEvent } = options;
  const dir = stateDir(projectDir);
  const round = getRound(projectDir);
  const step = getStep(projectDir);
  const ts = timestamp();
  const summary = extractSummary(content);

  // Use the last meaningful task line; update-task appends new directions.
  const taskFile = readFile(path.join(dir, "task.md"));
  const taskLines = taskFile.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("Created:") && !l.startsWith("Updated:"));
  const taskContext = taskLines[taskLines.length - 1] || "";

  let filesChangedSection = "";
  if (tag === "CODE" || tag === "FIX") {
    const files = getFilesChanged(projectDir);
    if (files.length > 0) {
      filesChangedSection = `**Files Changed**:\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
    }
  }

  let contextSection = "";
  const contextPath = path.join(dir, "context.md");
  if (fs.existsSync(contextPath)) {
    const ctxContent = readFile(contextPath);
    if (ctxContent && !ctxContent.includes("(visible to Lisa).\n\n\n")) {
      const ctxLines = ctxContent.split("\n").filter((l) => l.startsWith("- ["));
      if (ctxLines.length > 0) {
        contextSection = `**Context**: ${ctxLines.join("; ")}\n`;
      }
    }
  }

  const taskLine = taskContext ? `**Task**: ${taskContext}\n` : "";
  writeFile(
    path.join(dir, "work.md"),
    `# Ralph Work\n\n## [${tag}] Round ${round} | Step: ${step}\n${taskLine}${contextSection}**Updated**: ${ts}\n**Summary**: ${summary}\n${filesChangedSection ? "\n" + filesChangedSection : "\n"}${content}\n`
  );

  const historyContent = external
    ? `[${tag}] ${summary}\n\n(Full content in work.md)`
    : content;
  appendHistory("Ralph", historyContent, projectDir);
  updateLastAction("Ralph", content, projectDir);
  setTurn("lisa", projectDir);

  const testsCleaned = tag === "CONSENSUS" ? cleanTests(dir, onEvent) : false;
  return {
    round, step, summary, turnAfter: "lisa",
    roundAfter: parseInt(round, 10) || 0, testsCleaned, deadlockCount: null,
  };
}

/** Call only after turn/policy validation and under the caller's write protection. */
export function applyLisaSubmission(options: SubmissionWriteOptions): SubmissionWriteResult {
  const { content, external, tag, projectDir, onEvent } = options;
  const dir = stateDir(projectDir);
  const round = getRound(projectDir);
  const step = getStep(projectDir);
  const ts = timestamp();
  const summary = extractSummary(content);

  const reviewPath = path.join(dir, "review.md");
  const newEntry = `## [${tag}] Round ${round} | Step: ${step}\n**Updated**: ${ts}\n**Summary**: ${summary}\n\n${content}`;
  const existing = readFile(reviewPath);
  const REVIEW_SEP = "\n\n---\n\n";
  let entries: string[] = [];
  if (existing && !existing.startsWith("# Lisa Review\n\n(Waiting")) {
    const body = existing.replace(/^# Lisa Review\n\n/, "");
    entries = body.split(REVIEW_SEP).filter((e) => e.trim());
  }
  entries.push(newEntry);
  if (entries.length > 3) entries = entries.slice(-3);
  writeFile(reviewPath, `# Lisa Review\n\n${entries.join(REVIEW_SEP)}\n`);

  const historyContent = external
    ? `[${tag}] ${summary}\n\n(Full content in review.md)`
    : content;
  appendHistory("Lisa", historyContent, projectDir);
  updateLastAction("Lisa", content, projectDir);
  setTurn("ralph", projectDir);

  let deadlockCount: number | null = null;
  const nwCountPath = path.join(dir, "needs_work_count.txt");
  if (tag === "NEEDS_WORK") {
    const currentCount = parseInt(readFile(nwCountPath) || "0", 10);
    const newCount = currentCount + 1;
    writeFile(nwCountPath, String(newCount));
    const deadlockThreshold = parseInt(process.env.RL_DEADLOCK_THRESHOLD || "8", 10);
    if (newCount >= deadlockThreshold) {
      const deadlockPath = path.join(dir, "deadlock.txt");
      writeFile(deadlockPath, `DEADLOCK at round ${round}: ${newCount} consecutive NEEDS_WORK rounds\nTimestamp: ${ts}\nAction: Watcher will pause. User intervention required.`);
      deadlockCount = newCount;
      onEvent?.({ type: "deadlock", count: newCount });
    }
  } else {
    writeFile(nwCountPath, "0");
    const deadlockPath = path.join(dir, "deadlock.txt");
    try { fs.unlinkSync(deadlockPath); } catch {}
  }

  const testsCleaned = tag === "CONSENSUS" ? cleanTests(dir, onEvent) : false;
  const roundAfter = (parseInt(round, 10) || 0) + 1;
  setRound(roundAfter, projectDir);
  return { round, step, summary, turnAfter: "ralph", roundAfter, testsCleaned, deadlockCount };
}
