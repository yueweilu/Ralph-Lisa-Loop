import { HostContractError, inspectProject } from "./inspect.js";
import { claimHost, heartbeatHost, releaseHost } from "./lease.js";
import { snapshotProject } from "./snapshot.js";
import { bindSeat } from "./binding.js";
import { adoptLegacy, confirmAdoption } from "./adoption.js";

function options(args: string[], names: string[]): Record<string, string> {
  if (args.length !== names.length * 2 + 1 || args.at(-1) !== "--json") {
    throw new HostContractError("INVALID_ARGUMENTS", 2, `Usage: ralph-lisa host <action> ${names.map((name) => `${name} <value>`).join(" ")} --json`);
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!names.includes(name) || !value || value.startsWith("--") || name in values) {
      throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid or repeated host option");
    }
    values[name] = value;
  }
  if (names.some((name) => !(name in values))) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Missing host option");
  }
  return values;
}

export function cmdHost(args: string[]): void {
  try {
    let result: object;
    switch (args[0]) {
      case "inspect": {
        const opts = options(args.slice(1), ["--project"]);
        result = inspectProject(opts["--project"]);
        break;
      }
      case "claim": {
        const opts = options(args.slice(1), ["--project", "--host", "--owner-id"]);
        result = claimHost(opts["--project"], opts["--host"], opts["--owner-id"]);
        break;
      }
      case "heartbeat": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--owner-id"]);
        result = heartbeatHost(opts["--project"], opts["--lease-id"], opts["--owner-id"]);
        break;
      }
      case "adopt": {
        const opts = options(args.slice(1), ["--project"]);
        result = adoptLegacy(opts["--project"]);
        break;
      }
      case "confirm-adoption": {
        const opts = options(args.slice(1), ["--project", "--backup-id", "--decision"]);
        result = confirmAdoption(opts["--project"], opts["--backup-id"], opts["--decision"]);
        break;
      }
      case "snapshot": {
        const opts = options(args.slice(1), ["--project"]);
        result = snapshotProject(opts["--project"]);
        break;
      }
      case "bind-seat": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--role", "--workspace-id", "--pane-id", "--agent-target"]);
        result = bindSeat(opts["--project"], opts["--lease-id"], opts["--role"],
          opts["--workspace-id"], opts["--pane-id"], opts["--agent-target"]);
        break;
      }
      case "release": {
        const opts = options(args.slice(1), ["--project", "--lease-id"]);
        result = releaseHost(opts["--project"], opts["--lease-id"]);
        break;
      }
      default:
        throw new HostContractError("UNKNOWN_HOST_COMMAND", 2, "Usage: ralph-lisa host <inspect|adopt|confirm-adoption|claim|heartbeat|bind-seat|snapshot|release> ... --json");
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    const issue = error instanceof HostContractError
      ? error
      : new HostContractError("HOST_IO_ERROR", 8, "Unable to inspect or change host state");
    console.log(JSON.stringify({ schema: 1, status: "error", code: issue.code, message: issue.message }));
    process.exitCode = issue.exitCode;
  }
}
