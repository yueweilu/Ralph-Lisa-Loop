import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "../state.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, assertAdoptionReady, assertNoManualRuntime, entryExists, readLease } from "./lease.js";
import { HostBinding, readBinding, SeatBinding } from "./binding.js";
import { businessDigest } from "./business.js";
import { assertGenerationMatchesBusiness, readGeneration } from "./generation.js";

export interface HostSnapshot {
  schema: 1;
  status: "ok";
  project_realpath: string;
  state_realpath: string;
  session_id: string;
  turn: "ralph" | "lisa";
  round: number;
  step: string;
  host_state: "unclaimed" | "claimed";
  owner_id: string | null;
  state_digest: string;
  generation: number | null;
  binding_generation: number | null;
  binding_state: "unbound" | "partial" | "bound" | "stale";
  workspace_id: string | null;
  seats: { ralph: SeatBinding | null; lisa: SeatBinding | null } | null;
  last_receipt_id: string | null;
}

interface HostBindingSummary {
  ownerId: string | null;
  bindingGeneration: number | null;
  bindingState: HostSnapshot["binding_state"];
  binding: HostBinding | null;
}

const NO_BINDING: HostBindingSummary = {
  ownerId: null, bindingGeneration: null, bindingState: "unbound", binding: null,
};

function hostBindingSummary(state: string, project: string, sessionId: string): HostBindingSummary {
  const host = path.join(state, "host");
  if (!entryExists(host)) return NO_BINDING;
  const stat = fs.lstatSync(host);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(host) !== host) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Invalid host directory");
  }
  assertAdoptionReady(host, project, state, sessionId);
  for (const marker of ["claim.lock", "reconcile.json", "lease.json", "binding.pending", "adoption.pending", "generation.pending"]) {
    if (entryExists(path.join(host, marker))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Host marker ${marker} requires reconciliation`);
    }
  }
  const intents = path.join(host, "intents");
  if (entryExists(intents)) {
    const intentsStat = fs.lstatSync(intents);
    if (!intentsStat.isDirectory() || intentsStat.isSymbolicLink() || fs.readdirSync(intents).length > 0) {
      throw new HostContractError("NEEDS_RECONCILE", 7, "Pending host intents require reconciliation");
    }
  }
  // Later slices must validate receipts and candidates before exposing them.
  for (const future of ["receipts", "candidates"]) {
    if (entryExists(path.join(host, future))) {
      throw new HostContractError("NEEDS_RECONCILE", 7, `Unsupported host metadata: ${future}`);
    }
  }
  const binding = readBinding(host);
  if (binding && (binding.project_realpath !== project || binding.state_realpath !== state ||
      binding.session_id !== sessionId)) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Host binding belongs to another session");
  }
  if (!entryExists(path.join(host, "lease"))) {
    return binding
      ? { ownerId: null, bindingGeneration: binding.binding_generation, bindingState: "stale", binding: null }
      : NO_BINDING;
  }
  let lease;
  try {
    lease = readLease(host);
  } catch (error) {
    if (error instanceof HostContractError) throw error;
    throw new HostContractError("NEEDS_RECONCILE", 7, "Incomplete host lease");
  }
  if (lease.project_realpath !== project || lease.state_realpath !== state || lease.session_id !== sessionId) {
    throw new HostContractError("NEEDS_RECONCILE", 7, "Host lease belongs to another session");
  }
  if (!binding) {
    return { ownerId: lease.owner_id, bindingGeneration: null, bindingState: "unbound", binding: null };
  }
  if (binding.lease_id !== lease.lease_id) {
    return { ownerId: lease.owner_id, bindingGeneration: binding.binding_generation, bindingState: "stale", binding: null };
  }
  return {
    ownerId: lease.owner_id,
    bindingGeneration: binding.binding_generation,
    bindingState: binding.seats.ralph && binding.seats.lisa ? "bound" : "partial",
    binding,
  };
}

/** A coherent read across coordinated CLI writers; it never exposes a lease ID. */
export function snapshotProject(project: string): HostSnapshot {
  const projectRealpath = canonicalProject(project);
  const releaseLock = acquireHostLock(path.join(projectRealpath, STATE_DIR));
  try {
    const current = inspectProject(projectRealpath);
    if (!current.initialized || !current.state_realpath) {
      throw new HostContractError("SESSION_NOT_INITIALIZED", 3, "Initialize the RLL session before snapshot");
    }
    if (!current.session_id || current.contract_state !== "identified") {
      throw new HostContractError("ADOPT_REQUIRED", 3, "Legacy sessions require explicit host adopt before snapshot");
    }
    assertNoManualRuntime(current.project_realpath, current.state_realpath);
    const digest = businessDigest(current.state_realpath, current.turn!, current.round!, current.step!);
    const host = hostBindingSummary(current.state_realpath, current.project_realpath, current.session_id);
    const generation = readGeneration(path.join(current.state_realpath, "host"),
      current.project_realpath, current.state_realpath, current.session_id);
    if (generation) {
      assertGenerationMatchesBusiness(generation, digest, current.turn!, current.round!, current.step!);
    }
    return {
      schema: 1,
      status: "ok",
      project_realpath: current.project_realpath,
      state_realpath: current.state_realpath,
      session_id: current.session_id,
      turn: current.turn!,
      round: current.round!,
      step: current.step!,
      host_state: host.ownerId ? "claimed" : "unclaimed",
      owner_id: host.ownerId,
      state_digest: digest,
      generation: generation?.generation ?? null,
      binding_generation: host.bindingGeneration,
      binding_state: host.bindingState,
      workspace_id: host.binding?.workspace_id ?? null,
      seats: host.binding?.seats ?? null,
      last_receipt_id: generation?.last_receipt_id ?? null,
    };
  } finally {
    releaseLock();
  }
}
