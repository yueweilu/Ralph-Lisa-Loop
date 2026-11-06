import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { parseHerdrLaunchOptions, routeAutoArgs } from "../herdr/options.js";

describe("Herdr auto command routing", () => {
  it("preserves implicit tmux arguments and strips explicit tmux host", () => {
    const legacy = ["--full-auto", "Task", "with", "spaces"];
    assert.deepEqual(routeAutoArgs(legacy), { host: "tmux", args: legacy });
    assert.deepEqual(routeAutoArgs(["--host", "tmux", ...legacy]), { host: "tmux", args: legacy });
  });

  it("parses the long Herdr command and the short alias identically", () => {
    const args = ["--project", "./example", "--full-auto", "Write one README"];
    assert.deepEqual(routeAutoArgs(["--host", "herdr", ...args]),
      { host: "herdr", options: parseHerdrLaunchOptions(args) });
    assert.equal(parseHerdrLaunchOptions(args).project, path.resolve("./example"));
  });

  it("rejects malformed options before any project mutation", () => {
    for (const args of [
      ["--host", "herdr", ""],
      ["--host", "herdr", "Task", "extra"],
      ["--host", "herdr", "--project", "Task"],
      ["--host", "herdr", "--full-auto", "--full-auto", "Task"],
      ["--host", "herdr", "--unknown", "Task"],
      ["--host", "herdr", "--host", "tmux", "Task"],
      ["--host", "other", "Task"],
      ["--host", "tmux", "--project", ".", "Task"],
    ]) assert.throws(() => routeAutoArgs(args));
  });
});
