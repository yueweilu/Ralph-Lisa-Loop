/** Propose a candidate from a live Herdr Agent pane without asserting file authorship. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function output(value, code = 0) {
  process.stdout.write(`${JSON.stringify({ schema: 1, ...value })}\n`);
  process.exitCode = code;
}

function fail(code, exitCode = 4, details = {}) {
  output({ status: "not_ready", code, source_verification: "unverified", ...details }, exitCode);
}

function call(argv, args) {
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  });
  let value = null;
  try { value = JSON.parse(result.stdout); } catch { /* Herdr config-dir returns a path. */ }
  return { code: result.status, value, stdout: result.stdout?.trim() ?? "",
    error: result.error?.code ?? null };
}

async function host(cli, action, args) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = call(cli, ["host", action, ...args, "--json"]);
    if (result.value?.code !== "HOST_BUSY") return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { code: 4, value: { code: "HOST_BUSY" } };
}

function settings(herdr) {
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
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("INVALID_SETTINGS"); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.project !== undefined && (typeof value.project !== "string" ||
        !path.isAbsolute(value.project))) ||
      (value.rll_cli_argv !== undefined && (!Array.isArray(value.rll_cli_argv) ||
        value.rll_cli_argv.length < 1 || value.rll_cli_argv.length > 4 ||
        !value.rll_cli_argv.every((part) => typeof part === "string" && part))))
    throw new Error("INVALID_SETTINGS");
  return value;
}

function args(argv) {
  if (argv[0] !== "propose") throw new Error("INVALID_ARGUMENTS");
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!["--project", "--file", "--candidate-id"].includes(argv[i]) ||
        typeof argv[i + 1] !== "string" || argv[i + 1].length === 0 ||
        values[argv[i]] !== undefined) throw new Error("INVALID_ARGUMENTS");
    values[argv[i]] = argv[i + 1];
  }
  if (!path.isAbsolute(values["--project"] ?? "") || !values["--file"] ||
      !UUID.test(values["--candidate-id"] ?? "")) throw new Error("INVALID_ARGUMENTS");
  let project;
  try { project = fs.realpathSync.native(values["--project"]); }
  catch { throw new Error("PROJECT_UNAVAILABLE"); }
  return { project, file: values["--file"],
    candidateId: values["--candidate-id"].toLowerCase() };
}

async function main() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID ||
      !process.env.HERDR_WORKSPACE_ID || !process.env.HERDR_BIN_PATH ||
      !process.env.HERDR_SOCKET_PATH) return fail("HERDR_PANE_REQUIRED", 3);
  let input, config;
  const herdr = [process.env.HERDR_BIN_PATH];
  try { input = args(process.argv.slice(2)); config = settings(herdr); }
  catch (error) { return fail(error.message || "INVALID_ARGUMENTS", 2); }
  if (config.project) {
    let configuredProject;
    try { configuredProject = fs.realpathSync.native(config.project); }
    catch { return fail("INVALID_SETTINGS", 2); }
    if (configuredProject !== input.project) return fail("PROJECT_MISMATCH");
  }
  const cli = config.rll_cli_argv ?? ["ralph-lisa"];
  const current = call(herdr, ["pane", "current", "--current"]);
  const pane = current.value?.result?.pane;
  if (current.code !== 0 || !pane || pane.pane_id !== process.env.HERDR_PANE_ID ||
      pane.workspace_id !== process.env.HERDR_WORKSPACE_ID || !pane.terminal_id)
    return fail("CALLER_PANE_MISMATCH");
  const live = call(herdr, ["agent", "get", pane.pane_id]);
  const agent = live.value?.result?.agent;
  let cwd = null;
  try { cwd = fs.realpathSync.native(agent.cwd); } catch { /* Fail closed. */ }
  if (live.code !== 0 || !agent || cwd !== input.project ||
      agent.pane_id !== pane.pane_id || agent.workspace_id !== pane.workspace_id ||
      agent.terminal_id !== pane.terminal_id)
    return fail("CALLER_AGENT_MISMATCH");
  if (agent.agent_status !== "working")
    return fail("CALLER_AGENT_NOT_WORKING", 4, {
      observed_agent_status: ["idle", "done", "blocked", "unknown"].includes(agent.agent_status)
        ? agent.agent_status : "unknown",
    });
  const role = agent.name;
  const kind = role === "ralph" ? "claude" : role === "lisa" ? "codex" : null;
  if (!kind || agent.agent !== kind) return fail("CALLER_AGENT_MISMATCH");
  const checked = await host(cli, "snapshot", ["--project", input.project]);
  const snapshot = checked.value;
  if (checked.code !== 0 || snapshot?.status !== "ok")
    return fail(snapshot?.code || "RLL_SNAPSHOT_UNAVAILABLE");
  if (snapshot.project_realpath !== input.project || snapshot.turn !== role ||
      snapshot.host_state !== "claimed" || snapshot.binding_state !== "bound" ||
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.workspace_id !== pane.workspace_id ||
      snapshot.seats?.[role]?.pane_id !== pane.pane_id ||
      snapshot.seats?.[role]?.agent_target !== role)
    return fail("SEAT_BINDING_MISMATCH");
  const proposed = await host(cli, "propose", ["--project", input.project,
    "--role", role, "--file", input.file, "--candidate-id", input.candidateId]);
  const candidate = proposed.value;
  if (proposed.code !== 0 || candidate?.status !== "candidate")
    return fail(candidate?.code || "PROPOSAL_UNCERTAIN", proposed.code === 7 ? 7 : 4);
  if (candidate.project_realpath !== input.project ||
      candidate.candidate_id !== input.candidateId || candidate.role !== role ||
      candidate.session_id !== snapshot.session_id ||
      candidate.generation !== snapshot.generation ||
      candidate.binding_generation !== snapshot.binding_generation ||
      candidate.intended_workspace_id !== pane.workspace_id ||
      candidate.intended_pane_id !== pane.pane_id ||
      candidate.intended_agent_target !== role ||
      candidate.source_verification !== "unverified" ||
      !SHA256.test(candidate.content_sha256 ?? ""))
    return fail("PROPOSAL_IDENTITY_UNCERTAIN", 7);
  output({ status: "candidate_observed", candidate_id: candidate.candidate_id,
    content_sha256: candidate.content_sha256, project: input.project,
    session_id: snapshot.session_id, generation: snapshot.generation,
    role, observed_workspace_id: pane.workspace_id,
    observed_pane_id: pane.pane_id, observed_terminal_id: pane.terminal_id,
    source_verification: "unverified", commit_ready: false });
}

main().catch(() => fail("CANDIDATE_PROPOSE_FAILED", 7));
