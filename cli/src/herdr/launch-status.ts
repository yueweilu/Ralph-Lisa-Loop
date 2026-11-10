import * as fs from "node:fs";
import * as path from "node:path";
import { inspectProject } from "../host/inspect.js";
import { snapshotProject } from "../host/snapshot.js";
import { hasCompletedArchive } from "./completion-record.js";
import { readLaunchResult, readLaunchWorkspace, readProjectLaunchIntent } from "./launch-record.js";

function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Purely read-only. A previous `started` receipt alone is never treated as live activity. */
export function inspectHerdrLaunch(project: string): object {
  const inspection = inspectProject(path.resolve(project));
  if (!inspection.initialized || inspection.contract_state !== "identified" || !inspection.session_id)
    throw new Error("HERDR_SESSION_NOT_FOUND");
  const real = inspection.project_realpath;
  const intent = readProjectLaunchIntent(real);
  if (intent.session_id !== inspection.session_id) throw new Error("LAUNCH_SESSION_MISMATCH");
  const workspaceFile = path.join(real, ".dual-agent", "herdr-launch-workspace.json");
  const workspace = present(workspaceFile) ? readLaunchWorkspace(real, intent.request_id) : null;
  const result = workspace ? readLaunchResult(real, intent.request_id) : null;
  let host;
  try { host = snapshotProject(real); }
  catch (error) {
    return { schema: 1, status: "needs_reconcile", code: "HOST_SNAPSHOT_UNAVAILABLE",
      request_id: intent.request_id, project_realpath: real, session_id: intent.session_id,
      workspace_id: workspace?.workspace_id ?? null,
      snapshot_code: typeof error === "object" && error && "code" in error ?
        (error as { code: unknown }).code : null };
  }
  let completed = false;
  if (result?.status === "started" && workspace &&
      host.host_state === "unclaimed" && host.binding_state === "stale") {
    try { completed = hasCompletedArchive(intent, workspace, host); }
    catch {
      return { schema: 1, status: "needs_reconcile", code: "COMPLETION_ARCHIVE_UNAVAILABLE",
        request_id: intent.request_id, project_realpath: real, session_id: intent.session_id,
        workspace_id: workspace.workspace_id,
        host_state: host.host_state, binding_state: host.binding_state,
        generation: host.generation, turn: host.turn };
    }
  }
  const status = result?.status === "started"
    ? completed ? "completed" : host.host_state === "claimed" && host.binding_state === "bound" &&
      host.workspace_id === workspace?.workspace_id ? "claimed_unverified" : "needs_review"
    : result?.status ?? "pending";
  return { schema: 1, status, request_id: intent.request_id, project_realpath: real,
    session_id: intent.session_id, workspace_id: workspace?.workspace_id ?? null,
    launch_result: result?.status ?? null, launch_code: result?.code ?? null,
    host_state: host.host_state, binding_state: host.binding_state,
    generation: host.generation, turn: host.turn };
}

export function reportHerdrLaunchStatus(project: string): void {
  try { process.stdout.write(`${JSON.stringify(inspectHerdrLaunch(project))}\n`); }
  catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message : "HERDR_LAUNCH_STATUS_FAILED";
    process.stderr.write(`Herdr launch status: ${code}\n`);
    process.exitCode = 3;
  }
}
