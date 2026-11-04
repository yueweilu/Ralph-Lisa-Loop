import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.dirname(new URL(import.meta.url).pathname);
const helper = path.join(root, "candidate-propose.mjs");
const cli = path.join(root, "../../cli/dist/cli.js");

test("pane candidate proposal observes the bound Agent but keeps source unverified", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rll-herdr-candidate-pane-"));
  const project = path.join(temp, "project");
  const configDir = path.join(temp, "config");
  const fakeHerdr = path.join(temp, "herdr");
  fs.mkdirSync(project);
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    project, rll_cli_argv: [process.execPath, cli],
  }));
  fs.writeFileSync(fakeHerdr, `#!${process.execPath}\n` +
    `const a=process.argv.slice(2),p=process.env.FAKE_PROJECT;` +
    `if(a[0]==='plugin'&&a[1]==='config-dir')console.log(process.env.FAKE_CONFIG);` +
    `else if(a[0]==='pane'&&a[1]==='current')console.log(JSON.stringify({result:{pane:{pane_id:'w1:p1',workspace_id:'w1',terminal_id:process.env.FAKE_PANE_TERMINAL||'term-r'}}}));` +
    `else if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{name:process.env.FAKE_AGENT_NAME||'ralph',agent:process.env.FAKE_AGENT_KIND||'claude',agent_status:process.env.FAKE_AGENT_STATUS||'working',pane_id:'w1:p1',workspace_id:'w1',terminal_id:process.env.FAKE_AGENT_TERMINAL||'term-r',cwd:p}}}));` +
    `else process.exit(2);\n`);
  fs.chmodSync(fakeHerdr, 0o700);
  const runCli = (action, args = []) => {
    const result = spawnSync(process.execPath, [cli, "host", action,
      "--project", project, ...args, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const env = { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1",
    HERDR_WORKSPACE_ID: "w1", HERDR_BIN_PATH: fakeHerdr,
    HERDR_SOCKET_PATH: path.join(temp, "fake.sock"),
    FAKE_PROJECT: project, FAKE_CONFIG: configDir };
  const candidateId = "4a1a9922-42cf-436b-a689-01896695f407";
  const runHelper = (customEnv = env, id = candidateId) => {
    const result = spawnSync(process.execPath, [helper, "propose", "--project", project,
      "--file", "ralph-candidate.md", "--candidate-id", id],
    { env: customEnv, encoding: "utf8" });
    return { status: result.status, value: JSON.parse(result.stdout) };
  };
  try {
    assert.equal(spawnSync(process.execPath, [cli, "init", "--minimal", project],
      { encoding: "utf8" }).status, 0);
    const claimed = runCli("claim", ["--host", "herdr", "--owner-id",
      "8a3c801e-7c42-4802-8751-96e3f31a5bd1"]);
    runCli("bind-seat", ["--lease-id", claimed.lease_id, "--role", "ralph",
      "--workspace-id", "w1", "--pane-id", "w1:p1", "--agent-target", "ralph"]);
    runCli("bind-seat", ["--lease-id", claimed.lease_id, "--role", "lisa",
      "--workspace-id", "w1", "--pane-id", "w1:p2", "--agent-target", "lisa"]);
    const snapshot = runCli("snapshot");
    runCli("prepare-generation", ["--lease-id", claimed.lease_id,
      "--expected-digest", snapshot.state_digest]);
    fs.writeFileSync(path.join(project, "ralph-candidate.md"),
      "[PLAN] Add a small README.\n\nTest Plan: inspect README.\n");

    assert.equal(runHelper({ ...env, HERDR_ENV: "0" }).value.code, "HERDR_PANE_REQUIRED");
    assert.equal(runHelper({ ...env, HERDR_PANE_ID: "w1:p2" }).value.code,
      "CALLER_PANE_MISMATCH");
    assert.equal(runHelper({ ...env, FAKE_AGENT_TERMINAL: "term-replaced" }).value.code,
      "CALLER_AGENT_MISMATCH");
    assert.equal(runHelper({ ...env, FAKE_AGENT_NAME: "lisa", FAKE_AGENT_KIND: "codex" }).value.code,
      "SEAT_BINDING_MISMATCH");
    assert.equal(runHelper({ ...env, FAKE_AGENT_STATUS: "idle" }).value.code,
      "CALLER_AGENT_MISMATCH");
    assert.equal(runCli("snapshot").candidate_count, 0);

    const accepted = runHelper();
    assert.equal(accepted.status, 0);
    assert.equal(accepted.value.status, "candidate_observed");
    assert.equal(accepted.value.role, "ralph");
    assert.equal(accepted.value.observed_pane_id, "w1:p1");
    assert.equal(accepted.value.observed_terminal_id, "term-r");
    assert.equal(accepted.value.source_verification, "unverified");
    assert.equal(accepted.value.commit_ready, false);
    assert.equal(runHelper().value.candidate_id, candidateId);
    assert.equal(runCli("snapshot").candidate_count, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
