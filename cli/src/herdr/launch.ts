import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireSessionCommandLock } from "../host/guard.js";
import { canonicalProject } from "../host/inspect.js";
import { stateDir } from "../state.js";
import { initSessionIfAbsent } from "./session-init.js";
import { createLaunchIntent, readLaunchResult, recordLaunchPane, recordLaunchWorkspace } from "./launch-record.js";
import type { HerdrLaunchOptions } from "./options.js";

type HerdrResponse = { result?: Record<string, any>; running?: boolean; status?: string };

export class HerdrLaunchError extends Error {
  constructor(public readonly code: string, public readonly requestId?: string) { super(code); }
}

function existingState(project: string): boolean {
  try { fs.lstatSync(stateDir(project)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function command(args: string[], timeout = 15000): HerdrResponse {
  const session = process.env.RLL_HERDR_SESSION;
  if (session && !/^[a-zA-Z0-9_-]{1,48}$/.test(session)) throw new HerdrLaunchError("HERDR_SESSION_INVALID");
  const prefix = session ? ["--session", session] : [];
  const result = spawnSync(process.env.HERDR_BIN_PATH || "herdr", [...prefix, ...args],
    { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new HerdrLaunchError("HERDR_COMMAND_FAILED");
  try { return JSON.parse(result.stdout.trim()) as HerdrResponse; }
  catch { throw new HerdrLaunchError("HERDR_RESPONSE_INVALID"); }
}

function preflight(): void {
  const version = spawnSync(process.env.HERDR_BIN_PATH || "herdr", ["--version"],
    { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  const found = version.stdout?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (version.status !== 0 || !found ||
      [Number(found[1]), Number(found[2]), Number(found[3])].join(".") === "0.0.0" ||
      Number(found[1]) === 0 && (Number(found[2]) < 9 || Number(found[2]) === 9 && Number(found[3]) < 4))
    throw new HerdrLaunchError("HERDR_VERSION_REQUIRED");
  const server = command(["status", "server", "--json"]);
  if (server.running !== true || server.status !== "running")
    throw new HerdrLaunchError("HERDR_SERVER_NOT_RUNNING");
  const listing = command(["plugin", "list", "--json"]);
  const plugins = listing.result?.plugins;
  if (!Array.isArray(plugins)) throw new HerdrLaunchError("PLUGIN_LIST_INVALID");
  const plugin = plugins.find((item: any) => item.plugin_id === "ralph-lisa.loop" && item.enabled === true);
  if (!plugin) throw new HerdrLaunchError("HERDR_PLUGIN_REQUIRED");
  if (!Array.isArray(plugin.panes) || !plugin.panes.some((pane: any) => pane.id === "coordinator"))
    throw new HerdrLaunchError("PLUGIN_LAUNCH_ENTRYPOINT_REQUIRED");
}

export type HerdrLaunchReceipt = {
  status: "started" | "needs_input" | "needs_reconcile" | "not_ready" | "pending";
  request_id: string;
  project_realpath: string;
  session_id: string;
  workspace_id: string;
  coordinator_pane_id: string;
  blocked_role?: "ralph" | "lisa";
  blocked_pane_id?: string;
  code?: string;
};

function blockedAgent(workspaceId: string, project: string):
  { role: "ralph" | "lisa"; paneId: string } | null {
  for (const [role, kind] of [["ralph", "claude"], ["lisa", "codex"]] as const) {
    let agent: any;
    try { agent = command(["agent", "get", role], 5000).result?.agent; }
    catch { continue; }
    let cwd: string | null = null;
    try { cwd = fs.realpathSync.native(agent?.cwd); } catch { /* Ignore unrelated agents. */ }
    if (agent?.name === role && agent?.agent === kind &&
        agent?.workspace_id === workspaceId && cwd === project &&
        agent?.agent_status === "blocked" && typeof agent.pane_id === "string")
      return { role, paneId: agent.pane_id };
  }
  return null;
}

/** One launch request; an uncertain Herdr response must be inspected, never blindly retried. */
export async function launchHerdrTask(options: HerdrLaunchOptions): Promise<HerdrLaunchReceipt> {
  const project = canonicalProject(path.resolve(options.project));
  if (existingState(project)) throw new HerdrLaunchError("SESSION_EXISTS");
  preflight();
  const requestId = crypto.randomUUID();
  let sessionId: string;
  const release = acquireSessionCommandLock(stateDir(project));
  try {
    if (existingState(project)) throw new HerdrLaunchError("SESSION_EXISTS");
    sessionId = initSessionIfAbsent(project, options.task, requestId);
    createLaunchIntent(project, sessionId, requestId, options.fullAuto);
  } finally { release(); }

  const created = command(["workspace", "create", "--cwd", project,
    "--label", `Ralph-Lisa ${path.basename(project)}`, "--no-focus"]);
  const workspace = created.result?.workspace;
  const rootPane = created.result?.root_pane;
  if (created.result?.type !== "workspace_created" || !workspace?.workspace_id ||
      !rootPane?.pane_id || !rootPane?.terminal_id ||
      rootPane.workspace_id !== workspace.workspace_id)
    throw new HerdrLaunchError("WORKSPACE_CREATE_UNCERTAIN", requestId);
  const workspaceId = workspace.workspace_id as string;
  recordLaunchWorkspace(project, requestId, workspaceId, rootPane.pane_id, rootPane.terminal_id);

  const opened = command(["plugin", "pane", "open", "--plugin", "ralph-lisa.loop",
    "--entrypoint", "coordinator", "--placement", "tab", "--workspace", workspaceId,
    "--env", `RLL_LAUNCH_REQUEST_ID=${requestId}`, "--no-focus"]);
  const pane = opened.result?.plugin_pane?.pane;
  if (opened.result?.type !== "plugin_pane_opened" || !pane?.pane_id ||
      pane.workspace_id !== workspaceId)
    throw new HerdrLaunchError("COORDINATOR_PANE_UNCERTAIN", requestId);
  recordLaunchPane(project, requestId, pane.pane_id);

  for (let attempt = 0; attempt < 60; attempt++) {
    const result = readLaunchResult(project, requestId);
    if (result) return { status: result.status, request_id: requestId, project_realpath: project,
      session_id: sessionId, workspace_id: workspaceId, coordinator_pane_id: pane.pane_id,
      ...(result.code ? { code: result.code } : {}) };
    const blocked = blockedAgent(workspaceId, project);
    if (blocked) return { status: "needs_input", code: "AGENT_BLOCKED",
      request_id: requestId, project_realpath: project, session_id: sessionId,
      workspace_id: workspaceId, coordinator_pane_id: pane.pane_id,
      blocked_role: blocked.role, blocked_pane_id: blocked.paneId };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { status: "pending", code: "START_OUTCOME_UNKNOWN", request_id: requestId,
    project_realpath: project, session_id: sessionId,
    workspace_id: workspaceId, coordinator_pane_id: pane.pane_id };
}

export function reportHerdrLaunch(options: HerdrLaunchOptions): void {
  launchHerdrTask(options).then((receipt) => {
    process.stdout.write(`${JSON.stringify({ schema: 1, ...receipt })}\n`);
    if (receipt.status !== "started") process.exitCode = receipt.status === "pending" ? 7 : 3;
  }).catch((error) => {
    const code = error instanceof HerdrLaunchError ? error.code :
      error instanceof Error ? error.message : "HERDR_LAUNCH_FAILED";
    process.stderr.write(`Herdr launch stopped: ${code}${error instanceof HerdrLaunchError && error.requestId ? ` (request ${error.requestId})` : ""}\n`);
    process.exitCode = code === "SESSION_EXISTS" ? 4 : 3;
  });
}
