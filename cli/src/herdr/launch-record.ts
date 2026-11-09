import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LaunchIntent = {
  schema: 1;
  request_id: string;
  project_realpath: string;
  session_id: string;
  task_sha256: string;
  permission_profile: "interactive" | "full_auto";
  auto_commit: boolean;
};

export type LaunchWorkspace = {
  schema: 1;
  request_id: string;
  workspace_id: string;
  root_pane_id: string;
  root_terminal_id: string;
};

export type LaunchPane = { schema: 1; request_id: string; coordinator_pane_id: string };
export type LaunchResult = { schema: 1; request_id: string; status: "started" | "needs_input" | "needs_reconcile" | "not_ready"; code?: string };

function stateFile(project: string, name: string): string {
  return path.join(fs.realpathSync.native(project), ".dual-agent", name);
}

function writeExclusive(file: string, value: object): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function readRegular<T>(file: string): T {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("LAUNCH_RECORD_INVALID");
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/** Immutable launch intent. It never grants automatic candidate submission. */
export function createLaunchIntent(project: string, sessionId: string, requestId: string, fullAuto: boolean): LaunchIntent {
  if (!UUID.test(sessionId) || !UUID.test(requestId)) throw new Error("LAUNCH_ID_INVALID");
  const real = fs.realpathSync.native(project);
  const task = fs.readFileSync(stateFile(real, "task.md"));
  const intent: LaunchIntent = { schema: 1, request_id: requestId,
    project_realpath: real, session_id: sessionId,
    task_sha256: crypto.createHash("sha256").update(task).digest("hex"),
    permission_profile: fullAuto ? "full_auto" : "interactive", auto_commit: false };
  writeExclusive(stateFile(real, "herdr-launch-intent.json"), intent);
  return intent;
}

/** Historical evidence remains readable after a later controlled task update. */
export function readLaunchIntentEvidence(project: string, requestId: string): LaunchIntent {
  const real = fs.realpathSync.native(project);
  const intent = readRegular<LaunchIntent>(stateFile(real, "herdr-launch-intent.json"));
  const identity = readRegular<{ session_id?: string; project_realpath?: string }>(stateFile(real, "session.json"));
  if (intent.schema !== 1 || intent.request_id !== requestId ||
      intent.project_realpath !== real || !UUID.test(intent.session_id) ||
      identity.session_id !== intent.session_id || identity.project_realpath !== real ||
      !/^[0-9a-f]{64}$/.test(intent.task_sha256) ||
      !["interactive", "full_auto"].includes(intent.permission_profile) ||
      typeof intent.auto_commit !== "boolean") throw new Error("LAUNCH_INTENT_MISMATCH");
  return intent;
}

export function readLaunchIntent(project: string, requestId: string): LaunchIntent {
  const intent = readLaunchIntentEvidence(project, requestId);
  const task = fs.readFileSync(stateFile(project, "task.md"));
  if (intent.task_sha256 !== crypto.createHash("sha256").update(task).digest("hex"))
    throw new Error("LAUNCH_INTENT_MISMATCH");
  return intent;
}

export function readProjectLaunchIntent(project: string): LaunchIntent {
  const real = fs.realpathSync.native(project);
  const value = readRegular<LaunchIntent>(stateFile(real, "herdr-launch-intent.json"));
  if (!UUID.test(value.request_id ?? "")) throw new Error("LAUNCH_INTENT_MISMATCH");
  return readLaunchIntent(real, value.request_id);
}

export function recordLaunchWorkspace(project: string, requestId: string,
  workspaceId: string, rootPaneId: string, rootTerminalId: string): LaunchWorkspace {
  readLaunchIntent(project, requestId);
  if (!workspaceId || !rootPaneId || !rootTerminalId) throw new Error("WORKSPACE_ID_REQUIRED");
  const record: LaunchWorkspace = { schema: 1, request_id: requestId,
    workspace_id: workspaceId, root_pane_id: rootPaneId, root_terminal_id: rootTerminalId };
  writeExclusive(stateFile(project, "herdr-launch-workspace.json"), record);
  return record;
}

export function readLaunchWorkspace(project: string, requestId: string): LaunchWorkspace {
  readLaunchIntent(project, requestId);
  const record = readRegular<LaunchWorkspace>(stateFile(project, "herdr-launch-workspace.json"));
  if (record.schema !== 1 || record.request_id !== requestId ||
      !record.workspace_id || !record.root_pane_id || !record.root_terminal_id)
    throw new Error("LAUNCH_WORKSPACE_MISMATCH");
  return record;
}

export function recordLaunchPane(project: string, requestId: string, paneId: string): LaunchPane {
  readLaunchWorkspace(project, requestId);
  if (!paneId) throw new Error("COORDINATOR_PANE_ID_REQUIRED");
  const record: LaunchPane = { schema: 1, request_id: requestId, coordinator_pane_id: paneId };
  writeExclusive(stateFile(project, "herdr-launch-pane.json"), record);
  return record;
}

export function readLaunchResult(project: string, requestId: string): LaunchResult | null {
  readLaunchWorkspace(project, requestId);
  const file = stateFile(project, "herdr-launch-result.json");
  if (!fs.existsSync(file)) return null;
  const value = readRegular<LaunchResult>(file);
  if (value.schema !== 1 || value.request_id !== requestId ||
      !["started", "needs_input", "needs_reconcile", "not_ready"].includes(value.status))
    throw new Error("LAUNCH_RESULT_INVALID");
  return value;
}
