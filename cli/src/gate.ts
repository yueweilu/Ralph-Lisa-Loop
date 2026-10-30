/** Ralph's existing CODE/FIX test gate, with a result reusable by host commit. */
import { execSync } from "node:child_process";

export interface GateOptions {
  enabled: boolean;
  commands: string[];
  mode: "warn" | "block";
  /** Host callers bind checks to the canonical project; legacy CLI uses its current cwd. */
  cwd?: string;
}

export interface GateCheck {
  command: string;
  result: "pass" | "fail";
  error?: string;
}

export interface GateResult {
  result: "not_enabled" | "pass" | "warn" | "block";
  checks: GateCheck[];
}

export type GateRunner = (command: string, cwd?: string) => void;
export type GateObserver = (event: "start" | GateCheck) => void;

export function gateOptionsFromEnv(): GateOptions {
  return {
    enabled: process.env.RL_RALPH_GATE === "true",
    commands: (process.env.RL_GATE_COMMANDS || "").split("|").filter(Boolean),
    mode: process.env.RL_GATE_MODE === "block" ? "block" : "warn",
  };
}

function defaultRunner(command: string, cwd?: string): void {
  execSync(command, { cwd, stdio: "pipe", timeout: 120000 });
}

/** The observer preserves the legacy CLI's per-command progress output. */
export function evaluateGate(
  tag: string,
  options: GateOptions = gateOptionsFromEnv(),
  runner: GateRunner = defaultRunner,
  observer?: GateObserver
): GateResult {
  if ((tag !== "CODE" && tag !== "FIX") || !options.enabled || options.commands.length === 0) {
    return { result: "not_enabled", checks: [] };
  }

  const checks: GateCheck[] = [];
  observer?.("start");
  for (const command of options.commands) {
    let check: GateCheck;
    try {
      runner(command, options.cwd);
      check = { command, result: "pass" };
    } catch (error: unknown) {
      const failure = error as { stderr?: Buffer | string; status?: number };
      const detail = failure?.stderr
        ? failure.stderr.toString().trim().split("\n").slice(-3).join("\n")
        : "exit code " + failure?.status;
      check = { command, result: "fail", error: detail };
    }
    checks.push(check);
    observer?.(check);
  }
  if (checks.every((check) => check.result === "pass")) return { result: "pass", checks };
  return { result: options.mode, checks };
}
