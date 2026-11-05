import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewContinuation } from "./continue.mjs";

const digest = "a".repeat(64);
const review = { status: "review_required", project: "/tmp/project",
  session_id: "session", lease_id: "lease", generation: 2, turn: "ralph",
  last_receipt_id: "receipt", evidence_sha256: digest,
  continuation_blockers: [] };

test("continue pane cancels without starting a coordinator", async () => {
  let launches = 0;
  const result = await reviewContinuation({ ask: async () => "", write: () => {},
    call: () => ({ code: 0, value: review }),
    run: async () => { launches++; } });
  assert.equal(result.status, "cancelled");
  assert.equal(launches, 0);
});

test("continue pane passes only the exact reviewed evidence", async () => {
  const calls = [];
  const result = await reviewContinuation({ ask: async () => `CONTINUE ${digest}`,
    write: () => {}, call: () => ({ code: 0, value: review }),
    run: async (args) => {
      calls.push(args);
      return { status: "continued", project: review.project,
        lease_id: review.lease_id, replay: "not_replayed" };
    } });
  assert.equal(result.status, "continued");
  assert.deepEqual(calls, [["continue", digest, "reviewed-cursor-no-replay"]]);
});

test("continue pane refuses blocked preflight or uncertain write", async () => {
  await assert.rejects(reviewContinuation({ ask: async () => { throw new Error("asked"); },
    write: () => {}, call: () => ({ code: 4, value: {
      ...review, status: "not_ready", code: "CONTINUATION_BLOCKED",
      continuation_blockers: ["SEAT_NOT_READY_RALPH"],
    } }) }), /CONTINUATION_BLOCKED/);
  let launches = 0;
  await assert.rejects(reviewContinuation({ ask: async () => `CONTINUE ${digest}`,
    write: () => {}, call: () => ({ code: 0, value: review }),
    run: async () => { launches++; return { status: "unknown" }; } }),
  /CONTINUATION_OUTCOME_UNCERTAIN/);
  assert.equal(launches, 1);
});
