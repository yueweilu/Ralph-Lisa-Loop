import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveCliArgv } from "./cli-command.mjs";

test("checkout CLI takes priority over a global release", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, "integrations/herdr");
  const cli = path.join(root, "cli");
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(cli);
  fs.writeFileSync(path.join(cli, "package.json"), "{}\n");
  assert.deepEqual(resolveCliArgv(undefined, plugin),
    [process.execPath, path.join(cli, "dist/cli.js")]);
  assert.deepEqual(resolveCliArgv(["custom-cli", "--flag"], plugin),
    ["custom-cli", "--flag"]);
});

test("standalone plugin keeps the explicit global fallback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-standalone-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(resolveCliArgv(undefined, root), ["ralph-lisa"]);
});
