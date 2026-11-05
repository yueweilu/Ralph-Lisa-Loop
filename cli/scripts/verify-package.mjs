import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"));
const license = fs.readFileSync(path.join(cliRoot, "LICENSE"), "utf8");
const repositoryLicense = fs.readFileSync(path.join(cliRoot, "..", "LICENSE"), "utf8");
assert.equal(license, repositoryLicense, "CLI package license must match repository license");
assert.equal(manifest.license, "MIT", "CLI package license metadata must match LICENSE");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: cliRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
assert.equal(result.status, 0, result.stderr || result.error?.message || "npm pack failed");
const packages = JSON.parse(result.stdout);
assert.equal(packages.length, 1, "npm pack must describe one package");
const packed = packages[0];
assert.equal(packed.name, manifest.name);
assert.equal(packed.version, manifest.version);
const files = new Set(packed.files.map((entry) => entry.path));
for (const required of ["LICENSE", "README.md", "package.json", manifest.bin?.["ralph-lisa"]]) {
  assert.ok(required && files.has(required), `missing release file: ${required}`);
}
assert.ok([...files].some((file) => file.startsWith("templates/")),
  "CLI package must include its runtime templates");
for (const file of files) {
  assert.ok(!file.startsWith("src/") && !file.startsWith("dist/test/") &&
    !file.startsWith("node_modules/") && !file.endsWith(".log") &&
    !file.startsWith(".env"), `unexpected release file: ${file}`);
}
process.stdout.write(`verified ${packed.name}@${packed.version}: ${files.size} release files\n`);
