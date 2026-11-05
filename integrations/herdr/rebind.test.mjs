import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewRebind } from "./rebind.mjs";

const digest = "a".repeat(64);
const review = {
  status: "review_required", project: "/tmp/project", session_id: "session-1",
  old_lease_id: "lease-1", recovery_id: "recovery-1", generation: 0,
  evidence_sha256: digest, continuation_blockers: [], binding_plan: {
    workspace_id: "w1", seats: {
      ralph: { pane_id: "w1:p1", terminal_id: "term-r",
        native_session_fingerprint_sha256: "b".repeat(64) },
      lisa: { pane_id: "w1:p2", terminal_id: "term-l",
        native_session_fingerprint_sha256: null },
    },
  },
};

test("rebind pane cancels without claiming a lease", async () => {
  const calls = [];
  const result = await reviewRebind({ ask: async () => "", write: () => {},
    call: (script, args) => {
      calls.push([script, args]);
      return { code: 0, value: review };
    } });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, [["actions.mjs", ["rebind-check"]]]);
});

test("rebind pane submits only the exact reviewed evidence", async () => {
  const calls = [];
  const result = await reviewRebind({ ask: async () => `REBIND ${digest}`, write: () => {},
    call: (script, args) => {
      calls.push([script, args]);
      return script === "actions.mjs" ? { code: 0, value: review } :
        { code: 0, value: { status: "rebound_paused", project: review.project,
          lease_id: "new-lease", replay: "not_replayed" } };
    } });
  assert.equal(result.status, "rebound_paused");
  assert.deepEqual(calls[1], ["coordinator.mjs",
    ["rebind", digest, "verified-seats-no-replay"]]);
});

test("rebind pane refuses a blocked preflight or uncertain write", async () => {
  await assert.rejects(reviewRebind({ ask: async () => { throw new Error("asked"); },
    write: () => {}, call: () => ({ code: 4, value: {
      ...review, status: "not_ready", code: "REBIND_BLOCKED",
      continuation_blockers: ["CURSOR_STATE_MISMATCH"],
    } }) }), /REBIND_BLOCKED/);
  let writes = 0;
  await assert.rejects(reviewRebind({ ask: async () => `REBIND ${digest}`, write: () => {},
    call: (script) => script === "actions.mjs" ? { code: 0, value: review } :
      (writes++, { code: null, value: null }) }), /REBIND_OUTCOME_UNCERTAIN/);
  assert.equal(writes, 1);
});
