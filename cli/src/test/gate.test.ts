import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateGate, type GateCheck, type GateOptions } from "../gate.js";

const block: GateOptions = { enabled: true, commands: ["first", "second"], mode: "block" };

describe("structured Ralph gate", () => {
  it("skips non-CODE/FIX tags and disabled or empty gates without running commands", () => {
    const never = () => { throw new Error("runner must not be called"); };
    assert.equal(evaluateGate("PLAN", block, never).result, "not_enabled");
    assert.equal(evaluateGate("CODE", { ...block, enabled: false }, never).result, "not_enabled");
    assert.equal(evaluateGate("FIX", { ...block, commands: [] }, never).result, "not_enabled");
  });

  it("reports each result in order and completes all checks before blocking", () => {
    const seen: Array<"start" | GateCheck> = [];
    const result = evaluateGate("CODE", block, (command) => {
      if (command === "first") throw { stderr: Buffer.from("one\ntwo\nthree\nfour\n") };
    }, (event) => seen.push(event));
    assert.equal(result.result, "block");
    assert.deepEqual(result.checks, [
      { command: "first", result: "fail", error: "two\nthree\nfour" },
      { command: "second", result: "pass" },
    ]);
    assert.deepEqual(seen, ["start", ...result.checks]);
  });

  it("returns warnings in warn mode and pass when every command succeeds", () => {
    const warned = evaluateGate("FIX", { ...block, mode: "warn" }, () => {
      throw { status: 9 };
    });
    assert.equal(warned.result, "warn");
    assert.equal(warned.checks[0].error, "exit code 9");
    const passed = evaluateGate("CODE", block, () => {});
    assert.equal(passed.result, "pass");
    assert.equal(passed.checks.length, 2);
  });

  it("passes an explicit project cwd to every host gate check", () => {
    const calls: Array<[string, string | undefined]> = [];
    const result = evaluateGate("CODE", { ...block, cwd: "/tmp/project" },
      (command, cwd) => { calls.push([command, cwd]); });
    assert.equal(result.result, "pass");
    assert.deepEqual(calls, [["first", "/tmp/project"], ["second", "/tmp/project"]]);
  });
});
