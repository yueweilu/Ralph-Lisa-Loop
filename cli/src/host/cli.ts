import { HostContractError, inspectProject } from "./inspect.js";
import { claimHost, heartbeatHost, releaseHost } from "./lease.js";
import { snapshotProject } from "./snapshot.js";
import { bindSeat } from "./binding.js";
import { adoptLegacy, confirmAdoption } from "./adoption.js";
import { leaseRecoveryCheck, recoverLease } from "./recovery.js";
import { prepareGeneration } from "./generation.js";
import { proposeCandidate, reviewCandidates } from "./candidate.js";
import { receiptStatus } from "./receipt.js";
import { checkHostCommit } from "./commit-check.js";
import { confirmCandidateSource } from "./confirmation.js";
import { commitHostCandidate } from "./commit.js";
import { grantAutoAuthorization } from "./auto-authorization.js";
import { checkTaskUpdate, type TaskUpdateMode } from "./task-update-check.js";
import { commandLockCheck, retireCommandLock } from "./command-lock-recovery.js";

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

function decimal(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new HostContractError("INVALID_ARGUMENTS", 2, "Expected generation must be a decimal integer");
  }
  return Number(value);
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
      case "recovery-check": {
        const opts = options(args.slice(1), ["--project"]);
        result = leaseRecoveryCheck(opts["--project"]);
        break;
      }
      case "command-lock-check": {
        const opts = options(args.slice(1), ["--project"]);
        result = commandLockCheck(opts["--project"]);
        break;
      }
      case "retire-command-lock": {
        const opts = options(args.slice(1), ["--project", "--expected-evidence", "--decision"]);
        result = retireCommandLock(opts["--project"], opts["--expected-evidence"], opts["--decision"]);
        break;
      }
      case "recover-lease": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--expected-evidence", "--decision"]);
        result = recoverLease(opts["--project"], opts["--lease-id"], opts["--expected-evidence"], opts["--decision"]);
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
      case "prepare-generation": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--expected-digest"]);
        result = prepareGeneration(opts["--project"], opts["--lease-id"], opts["--expected-digest"]);
        break;
      }
      case "propose": {
        const opts = options(args.slice(1), ["--project", "--role", "--file", "--candidate-id"]);
        result = proposeCandidate(opts["--project"], opts["--role"], opts["--file"], opts["--candidate-id"]);
        break;
      }
      case "candidates": {
        const opts = options(args.slice(1), ["--project"]);
        result = reviewCandidates(opts["--project"]);
        break;
      }
      case "candidate-show": {
        const opts = options(args.slice(1), ["--project", "--candidate-id"]);
        result = reviewCandidates(opts["--project"], opts["--candidate-id"]);
        break;
      }
      case "receipt": {
        const opts = options(args.slice(1), ["--project", "--request-id"]);
        result = receiptStatus(opts["--project"], opts["--request-id"]);
        if ((result as { status?: string }).status === "needs_reconcile") process.exitCode = 7;
        break;
      }
      case "commit-check": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--request-id",
          "--candidate-id", "--expected-generation", "--expected-binding-generation"]);
        result = checkHostCommit(opts["--project"], opts["--lease-id"], opts["--request-id"],
          opts["--candidate-id"], decimal(opts["--expected-generation"]),
          decimal(opts["--expected-binding-generation"]));
        break;
      }
      case "task-update-check": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--request-id",
          "--expected-generation", "--expected-binding-generation", "--expected-digest",
          "--mode", "--file", "--content-sha256"]);
        result = checkTaskUpdate(opts["--project"], opts["--lease-id"], opts["--request-id"],
          decimal(opts["--expected-generation"]), decimal(opts["--expected-binding-generation"]),
          opts["--expected-digest"], opts["--mode"] as TaskUpdateMode,
          opts["--file"], opts["--content-sha256"]);
        break;
      }
      case "confirm-candidate": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--request-id",
          "--candidate-id", "--expected-generation", "--expected-binding-generation",
          "--expected-content-sha256", "--decision"]);
        result = confirmCandidateSource(opts["--project"], opts["--lease-id"], opts["--request-id"],
          opts["--candidate-id"], decimal(opts["--expected-generation"]),
          decimal(opts["--expected-binding-generation"]), opts["--expected-content-sha256"],
          opts["--decision"]);
        break;
      }
      case "authorize-auto": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--launch-request-id",
          "--expected-binding-generation", "--granted-via"]);
        if (opts["--granted-via"] !== "cli_auto_host_herdr" &&
            opts["--granted-via"] !== "plugin_start_task")
          throw new HostContractError("INVALID_ARGUMENTS", 2, "Invalid auto authorization entrypoint");
        result = grantAutoAuthorization(opts["--project"], opts["--lease-id"],
          opts["--launch-request-id"], decimal(opts["--expected-binding-generation"]),
          opts["--granted-via"]);
        break;
      }
      case "commit": {
        const opts = options(args.slice(1), ["--project", "--lease-id", "--request-id",
          "--candidate-id", "--expected-generation", "--expected-binding-generation"]);
        result = commitHostCandidate(opts["--project"], opts["--lease-id"], opts["--request-id"],
          opts["--candidate-id"], decimal(opts["--expected-generation"]),
          decimal(opts["--expected-binding-generation"]));
        if ((result as { status?: string }).status === "rejected") process.exitCode = 6;
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
        throw new HostContractError("UNKNOWN_HOST_COMMAND", 2, "Usage: ralph-lisa host <inspect|adopt|confirm-adoption|claim|heartbeat|command-lock-check|retire-command-lock|recover-lease|bind-seat|snapshot|prepare-generation|propose|candidates|candidate-show|commit-check|task-update-check|confirm-candidate|authorize-auto|commit|receipt|release> ... --json");
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
