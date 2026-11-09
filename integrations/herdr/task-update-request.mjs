/** Ralph Pane adapter: request a task change without exposing the coordinator lease. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCliArgv } from "./cli-command.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function output(value, code = 0) {
  process.stdout.write(`${JSON.stringify({ schema: 1, ...value })}\n`);
  process.exitCode = code;
}
function fail(code, exitCode = 4) {
  output({ status: "not_ready", code, source_verification: "unverified" }, exitCode);
}
function call(argv, args) {
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  });
  let value = null;
  try { value = JSON.parse(result.stdout); } catch { /* Fail closed below. */ }
  return { code: result.status, value, stdout: result.stdout?.trim() ?? "" };
}
function readSettings(herdr) {
  let dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) {
    const found = call(herdr, ["plugin", "config-dir", "ralph-lisa.loop"]);
    if (found.code !== 0 || !path.isAbsolute(found.stdout)) throw new Error("PLUGIN_CONFIG_UNAVAILABLE");
    dir = found.stdout;
  }
  const file = path.join(dir, "settings.json");
  if (!fs.existsSync(file)) return {};
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("INVALID_SETTINGS");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.project !== undefined && (typeof value.project !== "string" || !path.isAbsolute(value.project))) ||
      (value.rll_cli_argv !== undefined && (!Array.isArray(value.rll_cli_argv) ||
        value.rll_cli_argv.length < 1 || value.rll_cli_argv.length > 4 ||
        !value.rll_cli_argv.every((part) => typeof part === "string" && part))))
    throw new Error("INVALID_SETTINGS");
  return value;
}
function input(argv) {
  if (argv[0] !== "request") throw new Error("INVALID_ARGUMENTS");
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!["--project", "--file", "--mode", "--request-id"].includes(argv[i]) ||
        !argv[i + 1] || values[argv[i]] !== undefined) throw new Error("INVALID_ARGUMENTS");
    values[argv[i]] = argv[i + 1];
  }
  if (!path.isAbsolute(values["--project"] ?? "") ||
      !path.isAbsolute(values["--file"] ?? "") ||
      !["supplement", "switch"].includes(values["--mode"]) ||
      !UUID.test(values["--request-id"] ?? "")) throw new Error("INVALID_ARGUMENTS");
  const project = fs.realpathSync.native(values["--project"]);
  const file = path.resolve(values["--file"]);
  if (!file.startsWith(project + path.sep)) throw new Error("PROJECT_MISMATCH");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 65536 ||
      fs.realpathSync.native(file) !== file) throw new Error("INVALID_TASK_FILE");
  const bytes = fs.readFileSync(file);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.trim() || text.includes("\0")) throw new Error("INVALID_TASK_FILE");
  return { project, file, mode: values["--mode"], requestId: values["--request-id"].toLowerCase(),
    contentSha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function main() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID ||
      !process.env.HERDR_WORKSPACE_ID || !process.env.HERDR_BIN_PATH ||
      !process.env.HERDR_SOCKET_PATH) return fail("HERDR_PANE_REQUIRED", 3);
  let requested, settings;
  const herdr = [process.env.HERDR_BIN_PATH];
  try { requested = input(process.argv.slice(2)); settings = readSettings(herdr); }
  catch (error) { return fail(error.message || "INVALID_ARGUMENTS", 2); }
  if (settings.project) {
    try {
      if (fs.realpathSync.native(settings.project) !== requested.project) return fail("PROJECT_MISMATCH");
    } catch { return fail("INVALID_SETTINGS", 2); }
  }
  const paneRead = call(herdr, ["pane", "current", "--current"]);
  const pane = paneRead.value?.result?.pane;
  if (paneRead.code !== 0 || pane?.pane_id !== process.env.HERDR_PANE_ID ||
      pane?.workspace_id !== process.env.HERDR_WORKSPACE_ID || !pane.terminal_id)
    return fail("CALLER_PANE_MISMATCH");
  const agentRead = call(herdr, ["agent", "get", pane.pane_id]);
  const agent = agentRead.value?.result?.agent;
  let cwd = null;
  try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Fail closed. */ }
  if (agentRead.code !== 0 || agent?.name !== "ralph" || agent.agent !== "claude" ||
      agent.pane_id !== pane.pane_id || agent.workspace_id !== pane.workspace_id ||
      agent.terminal_id !== pane.terminal_id || cwd !== requested.project ||
      agent.agent_status !== "working") return fail("CALLER_AGENT_MISMATCH");
  const cli = resolveCliArgv(settings.rll_cli_argv);
  const snap = call(cli, ["host", "snapshot", "--project", requested.project, "--json"]);
  const snapshot = snap.value;
  if (snap.code !== 0 || snapshot?.status !== "ok") return fail(snapshot?.code || "RLL_SNAPSHOT_UNAVAILABLE");
  if (snapshot.project_realpath !== requested.project || snapshot.host_state !== "claimed" ||
      snapshot.binding_state !== "bound" || !Number.isSafeInteger(snapshot.generation) ||
      !SHA256.test(snapshot.state_digest ?? "") ||
      snapshot.workspace_id !== pane.workspace_id ||
      snapshot.seats?.ralph?.pane_id !== pane.pane_id ||
      snapshot.seats?.ralph?.agent_target !== "ralph") return fail("SEAT_BINDING_MISMATCH");
  const queue = path.join(snapshot.state_realpath, "host", "task-update-requests");
  try {
    if (!fs.existsSync(queue)) { fs.mkdirSync(queue, { mode: 0o700 }); syncDirectory(path.dirname(queue)); }
    const stat = fs.lstatSync(queue);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(queue) !== queue)
      return fail("TASK_REQUEST_STORE_INVALID", 7);
    const names = fs.readdirSync(queue);
    if (names.length > 0 && (names.length !== 1 || names[0] !== `${requested.requestId}.json`))
      return fail("TASK_REQUEST_ALREADY_PENDING");
    const record = { schema: 1, status: "requested", request_id: requested.requestId,
      project_realpath: requested.project, session_id: snapshot.session_id,
      workspace_id: pane.workspace_id, pane_id: pane.pane_id, terminal_id: pane.terminal_id,
      agent_target: "ralph", generation: snapshot.generation,
      binding_generation: snapshot.binding_generation, state_digest: snapshot.state_digest,
      last_receipt_id: snapshot.last_receipt_id, mode: requested.mode,
      file: requested.file, content_sha256: requested.contentSha256,
      source_verification: "unverified", requested_at: new Date().toISOString() };
    const target = path.join(queue, `${requested.requestId}.json`);
    if (names.length === 1) {
      const priorStat = fs.lstatSync(target);
      if (!priorStat.isFile() || priorStat.isSymbolicLink()) return fail("TASK_REQUEST_STORE_INVALID", 7);
      const prior = JSON.parse(fs.readFileSync(target, "utf8"));
      if (prior.request_id !== record.request_id || prior.project_realpath !== record.project_realpath ||
          prior.session_id !== record.session_id || prior.mode !== record.mode ||
          prior.content_sha256 !== record.content_sha256 || prior.generation !== record.generation)
        return fail("DUPLICATE_CONFLICT", 5);
    } else {
      const pending = `${target}.pending`;
      const fd = fs.openSync(pending, "wx", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(pending, target);
      syncDirectory(queue);
    }
    output({ status: "task_update_requested", request_id: requested.requestId,
      project: requested.project, session_id: snapshot.session_id, mode: requested.mode,
      generation: snapshot.generation, content_sha256: requested.contentSha256,
      source_verification: "unverified" });
  } catch { fail("TASK_REQUEST_UNCERTAIN", 7); }
}

main().catch(() => fail("TASK_REQUEST_FAILED", 7));
