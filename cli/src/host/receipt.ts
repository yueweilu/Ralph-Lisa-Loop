/** Read-only request status while formal commit receipts are not yet enabled. */
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_DIR } from "../state.js";
import { canonicalProject, HostContractError, inspectProject } from "./inspect.js";
import { acquireHostLock, entryExists } from "./lease.js";
import { auditHostIntent, readHostIntent } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HostReceiptStatus {
  schema: 1;
  status: "unknown" | "needs_reconcile";
  request_id: string;
  session_id: string | null;
  code?: "NEEDS_RECONCILE";
  reason?: string;
  intent?: {
    candidate_id: string;
    role: "ralph" | "lisa";
    generation_before: number;
    content_sha256: string;
    state_digest_before: string;
    state_digest_after: string;
    audit_status: "before" | "applied" | "partial";
    state_digest_observed: string | null;
  };
}

function reconcile(requestId: string, sessionId: string | null, reason: string): HostReceiptStatus {
  return { schema: 1, status: "needs_reconcile", request_id: requestId,
    session_id: sessionId, code: "NEEDS_RECONCILE", reason };
}

/** A pending write anywhere in the session prevents claiming any request is unknown. */
export function receiptStatus(project: string, requestId: string): HostReceiptStatus {
  if (!UUID.test(requestId)) throw new HostContractError("INVALID_ARGUMENTS", 2, "--request-id must be a UUID");
  requestId = requestId.toLowerCase();
  const root = canonicalProject(project);
  const releaseLock = acquireHostLock(path.join(root, STATE_DIR));
  try {
    let current;
    try {
      current = inspectProject(root);
    } catch (error) {
      // A torn business file can make ordinary inspection fail after an intent was written.
      const host = path.join(root, STATE_DIR, "host");
      if (entryExists(path.join(host, "intents")) || entryExists(path.join(host, "reconcile.json"))) {
        return reconcile(requestId, null, "state_invalid_with_host_intent");
      }
      throw error;
    }
    if (!current.initialized || !current.state_realpath || !current.session_id ||
        current.contract_state !== "identified") {
      throw new HostContractError("ADOPT_REQUIRED", 3, "An identified RLL session is required for receipt lookup");
    }
    const sessionId = current.session_id;
    const host = path.join(current.state_realpath, "host");
    if (!entryExists(host)) {
      return { schema: 1, status: "unknown", request_id: requestId, session_id: sessionId };
    }
    const hostStat = fs.lstatSync(host);
    if (!hostStat.isDirectory() || hostStat.isSymbolicLink() || fs.realpathSync.native(host) !== host) {
      return reconcile(requestId, sessionId, "invalid_host_directory");
    }
    for (const marker of ["reconcile.json", "claim.lock", "lease.json", "binding.pending",
      "adoption.pending", "generation.pending"]) {
      if (entryExists(path.join(host, marker))) return reconcile(requestId, sessionId, `pending_${marker}`);
    }
    // The current slice cannot validate committed receipts; their presence is never "unknown".
    if (entryExists(path.join(host, "receipts"))) {
      return reconcile(requestId, sessionId, "receipt_store_requires_review");
    }
    const intents = path.join(host, "intents");
    if (!entryExists(intents)) {
      return { schema: 1, status: "unknown", request_id: requestId, session_id: sessionId };
    }
    const stat = fs.lstatSync(intents);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(intents) !== intents) {
      return reconcile(requestId, sessionId, "invalid_intent_directory");
    }
    const names = fs.readdirSync(intents);
    if (names.length === 0) {
      return { schema: 1, status: "unknown", request_id: requestId, session_id: sessionId };
    }
    if (names.some((name) => !UUID.test(name.replace(/\.(json|pending)$/, "")) ||
        !/\.(json|pending)$/.test(name))) {
      return reconcile(requestId, sessionId, "invalid_intent_entry");
    }
    if (names.some((name) => name.endsWith(".pending"))) {
      return reconcile(requestId, sessionId, "interrupted_intent_write");
    }
    if (!names.includes(`${requestId}.json`)) {
      return reconcile(requestId, sessionId, "another_request_needs_reconcile");
    }
    try {
      const intent = readHostIntent(host, requestId);
      if (!intent || intent.project_realpath !== root ||
          intent.state_realpath !== current.state_realpath || intent.session_id !== sessionId) {
        return reconcile(requestId, sessionId, "intent_session_mismatch");
      }
      const audit = auditHostIntent(host, requestId);
      return { ...reconcile(requestId, sessionId, "prepared_intent_without_receipt"),
        intent: {
          candidate_id: intent.candidate_id, role: intent.role,
          generation_before: intent.generation_before, content_sha256: intent.content_sha256,
          state_digest_before: intent.state_digest_before,
          state_digest_after: intent.state_digest_after,
          audit_status: audit.status, state_digest_observed: audit.state_digest_observed,
        } };
    } catch {
      return reconcile(requestId, sessionId, "invalid_intent_record");
    }
  } finally {
    releaseLock();
  }
}
