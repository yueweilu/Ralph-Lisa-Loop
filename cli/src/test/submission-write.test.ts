import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyLisaSubmission, applyRalphSubmission, type SubmissionWriteEvent } from "../submission-write.js";

describe("shared submission business writes", () => {
  let project: string;
  let state: string;
  const oldThreshold = process.env.RL_DEADLOCK_THRESHOLD;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "rll-submit-write-"));
    state = path.join(project, ".dual-agent");
    fs.mkdirSync(state);
    for (const [name, value] of Object.entries({
      "task.md": "# Task\n\nImplement feature\n", "work.md": "# Ralph Work\n\n(Waiting)\n",
      "review.md": "# Lisa Review\n\n(Waiting for Lisa to respond)\n",
      "history.md": "# Collaboration History\n", "last_action.txt": "(No action yet)",
      "turn.txt": "ralph", "round.txt": "1", "step.txt": "planning",
    })) fs.writeFileSync(path.join(state, name), value);
  });

  afterEach(() => {
    if (oldThreshold === undefined) delete process.env.RL_DEADLOCK_THRESHOLD;
    else process.env.RL_DEADLOCK_THRESHOLD = oldThreshold;
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("writes both roles through an explicit project and reports side effects", () => {
    const ralph = applyRalphSubmission({
      projectDir: project, tag: "PLAN", external: true,
      content: "[PLAN] Build feature\n\nTest Plan: npm test",
    });
    assert.equal(ralph.turnAfter, "lisa");
    assert.equal(ralph.roundAfter, 1);
    assert.equal(fs.readFileSync(path.join(state, "turn.txt"), "utf8"), "lisa");
    assert.match(fs.readFileSync(path.join(state, "work.md"), "utf8"), /Test Plan: npm test/);
    assert.match(fs.readFileSync(path.join(state, "history.md"), "utf8"), /Full content in work\.md/);

    process.env.RL_DEADLOCK_THRESHOLD = "1";
    const events: SubmissionWriteEvent[] = [];
    const lisa = applyLisaSubmission({
      projectDir: project, tag: "NEEDS_WORK", external: true,
      content: "[NEEDS_WORK] Add coverage\n\nMissing test",
      onEvent: (event) => events.push(event),
    });
    assert.equal(lisa.turnAfter, "ralph");
    assert.equal(lisa.roundAfter, 2);
    assert.equal(lisa.deadlockCount, 1);
    assert.deepEqual(events, [{ type: "deadlock", count: 1 }]);
    assert.equal(fs.readFileSync(path.join(state, "round.txt"), "utf8"), "2");
    assert.match(fs.readFileSync(path.join(state, "review.md"), "utf8"), /Add coverage/);
    assert.match(fs.readFileSync(path.join(state, "history.md"), "utf8"), /Full content in review\.md/);

    fs.mkdirSync(path.join(state, "tests"));
    fs.writeFileSync(path.join(state, "tests", "evidence.txt"), "passed");
    events.length = 0;
    const consensus = applyRalphSubmission({
      projectDir: project, tag: "CONSENSUS", external: false,
      content: "[CONSENSUS] Done", onEvent: (event) => events.push(event),
    });
    assert.equal(consensus.testsCleaned, true);
    assert.deepEqual(events, [{ type: "tests_cleaned" }]);
    assert.equal(fs.existsSync(path.join(state, "tests")), false);
  });
});
