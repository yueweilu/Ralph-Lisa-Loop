import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const cli = path.join(__dirname, "..", "cli.js");

describe("isolated Herdr host contract sample", () => {
  it("runs Ralph → Lisa NEEDS_WORK → Ralph with stable receipts and explicit project paths", () => {
    const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rll-host-sample-")));
    const project = path.join(parent, "project-a");
    const other = path.join(parent, "project-b");
    fs.mkdirSync(project);
    fs.mkdirSync(other);
    const state = path.join(project, ".dual-agent");
    const otherState = path.join(other, ".dual-agent");
    const run = (cwd: string, args: string[], env = process.env) =>
      spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
    const host = (action: string, args: string[] = [], cwd = other, target = project) =>
      run(cwd, ["host", action, "--project", target, ...args, "--json"],
        { ...process.env, RL_STATE_DIR: otherState });
    const json = (result: ReturnType<typeof run>) => JSON.parse(result.stdout as string);
    const business = (dir: string) => ["work.md", "review.md", "history.md", "turn.txt", "round.txt"]
      .map((name) => fs.readFileSync(path.join(dir, name)));
    try {
      assert.equal(run(project, ["init", "--minimal", project]).status, 0);
      assert.equal(run(other, ["init", "--minimal", other]).status, 0);
      const otherBefore = business(otherState);
      const ownerId = randomUUID();
      const claim = host("claim", ["--host", "herdr", "--owner-id", ownerId]);
      assert.equal(claim.status, 0, claim.stdout);
      const leaseId = json(claim).lease_id as string;
      const sessionId = json(claim).session_id as string;
      const ralphBind = host("bind-seat", ["--lease-id", leaseId, "--role", "ralph",
        "--workspace-id", "workspace-sample", "--pane-id", "pane-r",
        "--agent-target", "agent-r"]);
      assert.equal(ralphBind.status, 0, ralphBind.stdout);
      const lisaBind = host("bind-seat", ["--lease-id", leaseId, "--role", "lisa",
        "--workspace-id", "workspace-sample", "--pane-id", "pane-l",
        "--agent-target", "agent-l"]);
      assert.equal(lisaBind.status, 0, lisaBind.stdout);
      const bindingGeneration = json(lisaBind).binding_generation as number;
      const baseline = host("snapshot");
      assert.equal(baseline.status, 0, baseline.stdout);
      assert.equal(json(baseline).project_realpath, project);
      assert.equal(json(baseline).session_id, sessionId);
      const prepared = host("prepare-generation", ["--lease-id", leaseId,
        "--expected-digest", json(baseline).state_digest]);
      assert.equal(prepared.status, 0, prepared.stdout);

      const receipts: Array<Record<string, any>> = [];
      function submit(role: "ralph" | "lisa", content: string, generation: number) {
        const candidateId = randomUUID();
        const requestId = randomUUID();
        const filename = `candidate-${generation}.md`;
        fs.writeFileSync(path.join(project, filename), content);
        const propose = host("propose", ["--role", role, "--file", filename,
          "--candidate-id", candidateId]);
        assert.equal(propose.status, 0, propose.stdout);
        assert.equal(json(propose).source_verification, "unverified");
        const args = ["--lease-id", leaseId, "--request-id", requestId,
          "--candidate-id", candidateId, "--expected-generation", String(generation),
          "--expected-binding-generation", String(bindingGeneration)];
        const check = host("commit-check", args);
        assert.equal(check.status, 0, check.stdout);
        assert.equal(json(check).status, "awaiting_source_confirmation");
        const confirmation = host("confirm-candidate", [...args,
          "--expected-content-sha256", json(check).content_sha256,
          "--decision", "reviewed_candidate_source"]);
        assert.equal(confirmation.status, 0, confirmation.stdout);
        const commit = host("commit", args);
        assert.equal(commit.status, 0, commit.stdout);
        const receipt = json(commit);
        assert.equal(receipt.status, "committed");
        assert.equal(receipt.request_id, requestId);
        assert.equal(receipt.session_id, sessionId);
        assert.equal(receipt.generation_before, generation);
        assert.equal(receipt.generation_after, generation + 1);
        assert.equal(receipt.binding_generation, bindingGeneration);
        assert.equal(receipt.source_confirmation, "human_asserted");
        assert.equal(receipt.source_verification, "unverified");
        assert.deepEqual(json(host("receipt", ["--request-id", requestId])), receipt);
        const after = host("snapshot");
        assert.equal(after.status, 0, after.stdout);
        assert.equal(json(after).generation, generation + 1);
        assert.equal(json(after).last_receipt_id, requestId);
        receipts.push(receipt);
        return { requestId, candidateId, args, receipt };
      }

      const first = submit("ralph", "[PLAN] Define the change.\n\nTest Plan: npm test\n", 0);
      assert.equal(json(host("snapshot")).turn, "lisa");
      assert.equal(json(host("snapshot")).round, 1);
      const wrongRole = host("propose", ["--role", "ralph", "--file", "candidate-0.md",
        "--candidate-id", randomUUID()]);
      assert.equal(wrongRole.status, 4);
      assert.equal(json(wrongRole).code, "WRONG_SEAT");

      const second = submit("lisa",
        "[NEEDS_WORK] Cover the missing case.\n\n- Issue at commands.ts:42 needs another check.\n", 1);
      assert.equal(json(host("snapshot")).turn, "ralph");
      assert.equal(json(host("snapshot")).round, 2);
      assert.equal(fs.readFileSync(path.join(state, "needs_work_count.txt"), "utf8").trim(), "1");
      const third = submit("ralph",
        "[PLAN] Add the missing case from Lisa's review.\n\nTest Plan: npm test and inspect commands.ts:42\n", 2);
      const final = json(host("snapshot"));
      assert.equal(final.turn, "lisa");
      assert.equal(final.round, 2);
      assert.equal(final.generation, 3);
      assert.equal(final.last_receipt_id, third.requestId);
      assert.deepEqual(receipts.map((receipt) => receipt.request_id),
        [first.requestId, second.requestId, third.requestId]);
      assert.equal(fs.readFileSync(path.join(state, "history.md"), "utf8").includes("[NEEDS_WORK]"), true);
      const beforeRetry = business(state);
      assert.deepEqual(json(host("commit", first.args)), first.receipt);
      assert.deepEqual(business(state), beforeRetry);
      assert.equal(json(host("snapshot")).generation, 3);
      assert.deepEqual(business(otherState), otherBefore);

      const staleCandidate = randomUUID();
      const staleRequest = randomUUID();
      fs.writeFileSync(path.join(project, "stale-pane.md"),
        "[PASS] Reviewed.\nReason: commands.ts:42 now covers the missing case.\n");
      const staleProposal = host("propose", ["--role", "lisa", "--file", "stale-pane.md",
        "--candidate-id", staleCandidate]);
      assert.equal(staleProposal.status, 0, staleProposal.stdout);
      const staleArgs = ["--lease-id", leaseId, "--request-id", staleRequest,
        "--candidate-id", staleCandidate, "--expected-generation", "3",
        "--expected-binding-generation", String(bindingGeneration)];
      const wrongGeneration = host("commit-check", staleArgs.map((value, index) =>
        index === 7 ? "2" : value));
      assert.equal(wrongGeneration.status, 5, wrongGeneration.stdout);
      assert.equal(json(wrongGeneration).code, "STALE_GENERATION");
      const rebound = host("bind-seat", ["--lease-id", leaseId, "--role", "lisa",
        "--workspace-id", "workspace-sample", "--pane-id", "pane-l-new",
        "--agent-target", "agent-l-new"]);
      assert.equal(rebound.status, 0, rebound.stdout);
      assert.equal(json(rebound).binding_generation, bindingGeneration + 1);
      const oldPaneCommit = host("commit", staleArgs);
      assert.equal(oldPaneCommit.status, 4, oldPaneCommit.stdout);
      assert.equal(json(oldPaneCommit).code, "WRONG_SEAT");
      assert.deepEqual(business(state), beforeRetry);
      assert.equal(json(host("snapshot")).generation, 3);

      // A copied session identity cannot make project B accept project A's request.
      const otherSession = fs.readFileSync(path.join(otherState, "session.json"));
      fs.copyFileSync(path.join(state, "session.json"), path.join(otherState, "session.json"));
      const wrongProject = host("commit", first.args, other, other);
      assert.equal(wrongProject.status, 3, wrongProject.stdout);
      assert.equal(json(wrongProject).code, "PROJECT_MISMATCH");
      assert.deepEqual(business(otherState), otherBefore);
      fs.writeFileSync(path.join(otherState, "session.json"), otherSession);

      // A pre-host legacy session still uses manual CLI, but cannot claim Herdr implicitly.
      fs.unlinkSync(path.join(otherState, "session.json"));
      const legacy = host("claim", ["--host", "herdr", "--owner-id", randomUUID()], other, other);
      assert.equal(legacy.status, 3, legacy.stdout);
      assert.equal(json(legacy).code, "ADOPT_REQUIRED");
      const manualEnv = { ...process.env };
      delete manualEnv.RL_STATE_DIR;
      delete manualEnv.TMUX;
      delete manualEnv.TMUX_PANE;
      const manual = run(other, ["submit-ralph", "[PLAN] Legacy manual work.\n\nTest Plan: npm test\n"], manualEnv);
      assert.equal(manual.status, 0, manual.stderr);
      assert.equal(fs.readFileSync(path.join(otherState, "turn.txt"), "utf8").trim(), "lisa");
      assert.equal(json(host("snapshot")).generation, 3);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
