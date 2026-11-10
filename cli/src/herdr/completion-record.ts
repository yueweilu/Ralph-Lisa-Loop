import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HostSnapshot } from "../host/snapshot.js";
import type { LaunchIntent, LaunchWorkspace } from "./launch-record.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A completed coordinator archive must agree with the current host snapshot. */
export function matchesCompletedRecord(record: Record<string, unknown>, fileName: string,
  intent: LaunchIntent, workspace: LaunchWorkspace, host: HostSnapshot): boolean {
  return record.phase === "completed" && record.auto_commit === true &&
    intent.auto_commit === true &&
    record.initial_status === "accepted" &&
    typeof record.owner_id === "string" && UUID.test(record.owner_id) &&
    fileName === `finished-${record.owner_id}.json` &&
    record.launch_request_id === intent.request_id &&
    record.project_realpath === host.project_realpath &&
    record.session_id === intent.session_id &&
    record.workspace_id === workspace.workspace_id &&
    typeof record.completed_at === "string" && !Number.isNaN(Date.parse(record.completed_at)) &&
    Number.isSafeInteger(record.cursor_generation) &&
    (record.cursor_generation as number) > 0 &&
    record.cursor_generation === host.generation &&
    typeof record.cursor_receipt_id === "string" && UUID.test(record.cursor_receipt_id) &&
    record.cursor_receipt_id === host.last_receipt_id &&
    record.cursor_turn === host.turn &&
    typeof record.completion_state_digest === "string" &&
    /^[0-9a-f]{64}$/.test(record.completion_state_digest) &&
    record.completion_state_digest === host.state_digest &&
    host.host_state === "unclaimed" && host.binding_state === "stale";
}

/** Read only the plugin's project-scoped archive; no Herdr process is started. */
export function hasCompletedArchive(intent: LaunchIntent, workspace: LaunchWorkspace,
  host: HostSnapshot): boolean {
  const xdgState = process.env.XDG_STATE_HOME;
  const stateHome = xdgState && path.isAbsolute(xdgState)
    ? xdgState : path.join(os.homedir(), ".local", "state");
  const key = crypto.createHash("sha256").update(host.project_realpath).digest("hex");
  const dir = path.join(stateHome, "herdr", "plugins", "ralph-lisa.loop", "sessions", key);
  let names: string[];
  try { names = fs.readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    if (!/^finished-[0-9a-f-]+\.json$/i.test(name)) continue;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; }
    catch { continue; }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (matchesCompletedRecord(record, name, intent, workspace, host)) return true;
  }
  return false;
}
