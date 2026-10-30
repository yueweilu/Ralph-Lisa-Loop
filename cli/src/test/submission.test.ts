import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { checkSubmission } from "../submission.js";

const oldMode = process.env.RL_POLICY_MODE;
afterEach(() => {
  if (oldMode === undefined) delete process.env.RL_POLICY_MODE;
  else process.env.RL_POLICY_MODE = oldMode;
});

describe("shared submission checks", () => {
  it("checks turn and tag before policy for both roles", () => {
    process.env.RL_POLICY_MODE = "block";
    assert.equal(checkSubmission("ralph", "[PLAN] No test plan", "lisa").failure, "wrong_turn");
    assert.equal(checkSubmission("lisa", "bad content", "lisa").failure, "invalid_tag");
    assert.equal(checkSubmission("ralph", "bad content", "ralph").failure, "invalid_tag");
  });

  it("returns the same policy block for Ralph and Lisa", () => {
    process.env.RL_POLICY_MODE = "block";
    const ralph = checkSubmission("ralph", "[PLAN] Missing tests", "ralph");
    assert.equal(ralph.failure, "policy");
    assert.ok(ralph.violations.some((v) => v.rule === "plan-test-plan"));
    const lisa = checkSubmission("lisa", "[PASS] Fine", "lisa");
    assert.equal(lisa.failure, "policy");
    assert.ok(lisa.violations.length > 0);
  });

  it("enforces NEEDS_WORK after policy and preserves warn/off semantics", () => {
    const content = "[PLAN] New idea\n\nTest Plan: npm test";
    process.env.RL_POLICY_MODE = "block";
    const blocked = checkSubmission("ralph", content, "ralph", "NEEDS_WORK");
    assert.equal(blocked.failure, "needs_work");
    assert.equal(blocked.violations[0].rule, "needs-work-response");

    process.env.RL_POLICY_MODE = "warn";
    const warned = checkSubmission("ralph", content, "ralph", "NEEDS_WORK");
    assert.equal(warned.failure, null);
    assert.equal(warned.needsWorkWarnings[0].rule, "needs-work-response");
    assert.equal(warned.violations.length, 1);

    process.env.RL_POLICY_MODE = "off";
    const unchecked = checkSubmission("ralph", content, "ralph", "NEEDS_WORK");
    assert.equal(unchecked.failure, null);
    assert.deepEqual(unchecked.violations, []);
  });
});
