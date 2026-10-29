import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Create identity only after init has populated its normal business files. */
export function writeSessionIdentity(projectDir: string, stateDir: string): string {
  const sessionId = crypto.randomUUID();
  const identity = {
    schema: 1,
    session_id: sessionId,
    project_realpath: fs.realpathSync.native(projectDir),
    state_realpath: fs.realpathSync.native(stateDir),
    created_at: new Date().toISOString(),
  };
  const identityPath = path.join(stateDir, "session.json");
  const fd = fs.openSync(identityPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(identity) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return sessionId;
}
