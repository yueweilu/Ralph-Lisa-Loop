import { HostContractError, inspectProject } from "./inspect.js";
import { claimHost, releaseHost } from "./lease.js";

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
      case "release": {
        const opts = options(args.slice(1), ["--project", "--lease-id"]);
        result = releaseHost(opts["--project"], opts["--lease-id"]);
        break;
      }
      default:
        throw new HostContractError("UNKNOWN_HOST_COMMAND", 2, "Usage: ralph-lisa host <inspect|claim|release> ... --json");
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
