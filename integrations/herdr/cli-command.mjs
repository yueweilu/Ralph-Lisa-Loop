import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));

export function resolveCliArgv(configured, root = pluginRoot) {
  if (configured !== undefined) return configured;
  const cliRoot = path.resolve(root, "../../cli");
  if (fs.existsSync(path.join(cliRoot, "package.json"))) {
    // A source checkout must use its own CLI. If it has not been built, the
    // invocation fails instead of silently selecting an older global release.
    return [process.execPath, path.join(cliRoot, "dist/cli.js")];
  }
  return ["ralph-lisa"];
}
