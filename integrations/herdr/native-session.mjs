import * as crypto from "node:crypto";

export function nativeSessionReference(agent, kind) {
  if (!agent) return { status: "unavailable", fingerprint_sha256: null };
  const reference = agent.agent_session;
  if (reference == null) return { status: "missing", fingerprint_sha256: null };
  if (reference.agent !== kind || typeof reference.kind !== "string" || !reference.kind ||
      typeof reference.source !== "string" || !reference.source ||
      typeof reference.value !== "string" || !reference.value)
    return { status: "invalid", fingerprint_sha256: null };
  return { status: "present", fingerprint_sha256: crypto.createHash("sha256")
    .update(JSON.stringify({ agent: reference.agent, kind: reference.kind,
      source: reference.source, value: reference.value })).digest("hex") };
}
