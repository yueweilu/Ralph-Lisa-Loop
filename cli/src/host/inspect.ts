import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "../state.js";

export class HostContractError extends Error {
  constructor(
    public readonly code: string,
    public readonly exitCode: number,
    message: string
  ) {
    super(message);
    this.name = "HostContractError";
  }
}

export interface HostInspection {
  schema: 1;
  status: "ok";
  project_realpath: string;
  state_realpath: string | null;
  initialized: boolean;
  contract_state: "absent" | "legacy" | "identified";
  session_id: string | null;
  turn: "ralph" | "lisa" | null;
  round: number | null;
  step: string | null;
}

function readRequired(dir: string, name: string): string {
  let value: string;
  try {
    value = fs.readFileSync(path.join(dir, name), "utf8").trim();
  } catch {
    throw new HostContractError("STATE_INVALID", 7, `Missing or unreadable ${name}`);
  }
  if (!value) {
    throw new HostContractError("STATE_INVALID", 7, `Empty ${name}`);
  }
  return value;
}

export function canonicalProject(project: string): string {
  if (!path.isAbsolute(project)) {
    throw new HostContractError("PROJECT_ABSOLUTE_REQUIRED", 2, "--project must be an absolute path");
  }
  let realpath: string;
  try {
    realpath = fs.realpathSync.native(project);
    if (!fs.statSync(realpath).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new HostContractError("PROJECT_NOT_FOUND", 3, "--project must name an existing directory");
  }
  return realpath;
}

function readSessionId(stateDir: string, projectRealpath: string): string | null {
  const sessionPath = path.join(stateDir, "session.json");
  let sessionStat: fs.Stats;
  try {
    sessionStat = fs.lstatSync(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Cannot inspect session.json");
    }
    // An incomplete migration must never look like an ordinary legacy session.
    if (fs.existsSync(path.join(stateDir, "host"))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Host metadata exists without session.json");
    }
    return null;
  }
  if (!sessionStat.isFile() || sessionStat.isSymbolicLink()) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "session.json must be a regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  } catch {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unreadable session.json");
  }
  if (!value || typeof value !== "object") {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid session.json");
  }
  const session = value as Record<string, unknown>;
  if (session.schema !== 1 || typeof session.session_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.session_id)) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Unsupported or invalid session.json");
  }
  if (session.project_realpath !== projectRealpath) {
    throw new HostContractError("PROJECT_MISMATCH", 3, "session.json belongs to another project");
  }
  if (session.state_realpath !== stateDir) {
    throw new HostContractError("PROJECT_MISMATCH", 3, "session.json names another state directory");
  }
  return session.session_id;
}

/** Read only: never consult CWD, RL_STATE_DIR, or a tmux session. */
export function inspectProject(project: string): HostInspection {
  const projectRealpath = canonicalProject(project);
  const statePath = path.join(projectRealpath, STATE_DIR);
  let stateStat: fs.Stats;
  try {
    stateStat = fs.lstatSync(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schema: 1,
        status: "ok",
        project_realpath: projectRealpath,
        state_realpath: null,
        initialized: false,
        contract_state: "absent",
        session_id: null,
        turn: null,
        round: null,
        step: null,
      };
    }
    throw new HostContractError("STATE_INVALID", 7, "Cannot inspect state directory");
  }
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new HostContractError("PROJECT_MISMATCH", 3, ".dual-agent must be a directory inside the project");
  }
  const stateRealpath = fs.realpathSync.native(statePath);
  if (stateRealpath !== statePath) {
    throw new HostContractError("PROJECT_MISMATCH", 3, ".dual-agent resolves outside the project");
  }

  const recordedRoot = path.join(statePath, ".project_root");
  if (fs.existsSync(recordedRoot)) {
    let rootRealpath: string;
    try {
      rootRealpath = fs.realpathSync.native(readRequired(statePath, ".project_root"));
    } catch {
      throw new HostContractError("PROJECT_MISMATCH", 3, "Recorded project root is unavailable");
    }
    if (rootRealpath !== projectRealpath) {
      throw new HostContractError("PROJECT_MISMATCH", 3, ".dual-agent belongs to another project");
    }
  }

  const turn = readRequired(statePath, "turn.txt");
  const roundText = readRequired(statePath, "round.txt");
  const step = readRequired(statePath, "step.txt");
  if (turn !== "ralph" && turn !== "lisa") {
    throw new HostContractError("STATE_INVALID", 7, "Invalid turn.txt");
  }
  const round = Number(roundText);
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new HostContractError("STATE_INVALID", 7, "Invalid round.txt");
  }
  const sessionId = readSessionId(stateRealpath, projectRealpath);
  return {
    schema: 1,
    status: "ok",
    project_realpath: projectRealpath,
    state_realpath: stateRealpath,
    initialized: true,
    contract_state: sessionId ? "identified" : "legacy",
    session_id: sessionId,
    turn,
    round,
    step,
  };
}
