import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createJumpResetStore } from "./merge-bar-jump-reset";

const HEAD = "a".repeat(40);
const GROUP = "b".repeat(40);
const BASE = "c".repeat(40);
const OTHER = "d".repeat(40);
const AT = "2026-10-07T10:00:00Z";

test.each([
  { scenario: "ready", reason: "QUEUED" },
  { scenario: "jump-ready", reason: "QUEUED AT THE FRONT" },
  { scenario: "jump-pending", reason: "JUMP PENDING" },
  { scenario: "hold", reason: "hold" },
  { scenario: "review", reason: "REVIEW" },
  { scenario: "checks", reason: "REQUIRED_CHECK" },
  { scenario: "migration", reason: "MIGRATION" },
  { scenario: "head-moved", reason: "HEAD" },
  { scenario: "dry", reason: "dry run" },
])(
  "recovery retains native merge gates: $scenario",
  ({ scenario, reason }) => {
    const isJump = scenario === "jump-ready" || scenario === "jump-pending";
    const directory = mkdtempSync(path.join(tmpdir(), "jump-requeue-cli-"));
    try {
      const state = path.join(directory, "state");
      const store = createJumpResetStore(path.join(state, "jump-resets"));
      expect(
        store
          .recordJump({ repo: "stella/stella", pr: 123, head: HEAD, at: AT })
          .isOk(),
      ).toBe(true);
      const calls = path.join(directory, "calls.jsonl");
      const marker = path.join(directory, "queued");
      const fixture = path.join(directory, "fixture.json");
      writeFileSync(
        fixture,
        JSON.stringify({
          scenario,
          calls,
          marker,
          head: HEAD,
          group: GROUP,
          base: BASE,
          other: OTHER,
          at: AT,
        }),
      );
      const executable = path.join(directory, "gh");
      writeFileSync(
        executable,
        `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const f = JSON.parse(readFileSync(${JSON.stringify(fixture)}, "utf-8"));
const args = Bun.argv.slice(2);
const text = args.join(" ");
appendFileSync(f.calls, JSON.stringify(args) + "\\n");
const emit = value => console.log(JSON.stringify(value));
const entry = { id: "entry", position: 1, jump: f.scenario.startsWith("jump-"), state: "QUEUED" };
const pr = { id: "PR_fixture", number: 123, title: "fix: queue recovery", state: "OPEN", isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", headRefOid: f.head, baseRefName: "main", updatedAt: f.at, autoMergeRequest: null, mergeQueueEntry: existsSync(f.marker) ? entry : null };
if (args.at(0) === "variable") {
  if (f.scenario === "hold") console.log("hold");
  else { console.error("variable STELLA_MERGE_HOLD was not found"); process.exit(1); }
} else if (text.includes("enqueuePullRequest")) {
  writeFileSync(f.marker, String(Date.now())); emit({ data: { enqueuePullRequest: { mergeQueueEntry: entry } } });
} else if (text.includes("entries(first:100)")) {
  const nodes = f.scenario === "jump-pending" ? [] : [{ position: 1, jump: true, state: "QUEUED", pullRequest: { number: 123 } }];
  emit({ data: { repository: { mergeQueue: { entries: { totalCount: nodes.length, nodes } } } } });
} else if (text.includes("reviewThreads")) {
  emit({ nodes: f.scenario === "review" ? [{ id: "thread", isResolved: false, isOutdated: false }] : [], pageInfo: { hasNextPage: false } });
} else if (text.includes("timelineItems")) {
  emit(f.scenario.startsWith("jump-") ? [] : [{ __typename: "PullRequestCommit", commit: { oid: f.head } }, { __typename: "RemovedFromMergeQueueEvent", createdAt: f.at, reason: "failed_checks", beforeCommit: { oid: f.group } }]);
} else if (text.includes("actions/runs?event=merge_group")) {
  emit({ total_count: 1, workflow_runs: [{ id: 7, event: "merge_group", head_sha: f.group, conclusion: "cancelled", head_branch: "gh-readonly-queue/main/pr-123-" + f.base, html_url: "https://github.com/stella/stella/actions/runs/7" }] });
} else if (text.includes("actions/runs/7/jobs")) {
  emit({ total_count: 1, jobs: [{ id: 71, conclusion: "cancelled", completed_at: "2026-10-07T10:00:01Z" }] });
} else if (text.includes("rules/branches/main")) {
  emit([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci-result" }] } }, { type: "merge_queue", parameters: {} }]);
} else if (text.includes("commits/main")) emit({ sha: f.base, committedAt: f.at });
else if (text.includes("actions/runs?head_sha=")) {}
else if (text.includes("check-runs/1")) emit({ details_url: "https://github.com/stella/stella/actions/runs/1" });
else if (text.includes("check-runs")) console.log("1\\tci-result\\tcompleted\\t" + (f.scenario === "checks" ? "failure" : "success"));
else if (text.includes("actions/runs/1")) emit({ id: 1, head_sha: f.head, pull_requests: [{ number: 123, head: { sha: f.head }, base: { ref: "main", sha: f.base } }] });
else if (text.includes("compare/")) emit({ status: "identical" });
else if (text.includes("pulls/123/files")) emit(f.scenario === "migration" ? { status: "renamed", filename: "apps/api/drizzle/20260802120000_new/migration.sql", previous_filename: "apps/api/drizzle/20260801120000_original/migration.sql" } : { status: "added", filename: "docs/queue.md" });
else if (text.includes("pulls/123")) emit(1);
else if (args.at(0) === "pr" && args.at(1) === "list") emit([]);
else if (text.includes("contents/scripts/ratchet-definition-paths.json")) emit(["scripts/ratchet.ts"]);
else if (args.at(0) === "pr") emit({ headRefOid: f.scenario === "head-moved" ? f.other : f.head });
else if (text.includes("api graphql")) emit({ data: { repository: { pullRequest: pr } } });
else { console.error("Unexpected fake gh request: " + text); process.exit(96); }
`,
      );
      chmodSync(executable, 0o700);
      const cmd = [
        process.execPath,
        "scripts/merge-bar.ts",
        ...(isJump
          ? ["--jump", "123"]
          : ["--requeue-jump-reset", "123", "--expected-head-sha", HEAD]),
        ...(scenario === "dry" ? ["--dry-run"] : []),
      ];
      const env = {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
        NODE_ENV: "test",
        STELLA_LOCAL_DEV: "1",
        STELLA_MERGE_BAR_TEST_SKIP_FRESHNESS: "1",
        STELLA_MERGE_BAR_STATE_DIR: state,
      };
      const run = () =>
        Bun.spawnSync({ cmd, env, stdout: "pipe", stderr: "pipe" });
      const result = run();
      const output = result.stdout.toString() + result.stderr.toString();
      let expectedExit =
        scenario === "ready" || scenario === "dry" || isJump ? 0 : 1;
      if (scenario === "jump-pending") {
        expectedExit = 2;
      }
      expect(result.exitCode, output).toBe(expectedExit);
      expect(output.toLowerCase()).toContain(reason.toLowerCase());
      const mutations = () =>
        readFileSync(calls, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((args: string[]) =>
            args.some((arg) =>
              /enqueuePullRequest|enablePullRequestAutoMerge/u.test(arg),
            ),
          );
      expect(mutations()).toHaveLength(scenario === "ready" || isJump ? 1 : 0);
      expect(existsSync(path.join(state, "jump-resets", "rearms"))).toBe(
        scenario === "ready",
      );
      if (isJump) {
        const records = store.readJumps();
        expect(records.isOk()).toBe(true);
        if (records.isOk()) {
          expect(records.value).toHaveLength(2);
          const accepted = records.value.find((record) => record.at !== AT);
          expect(accepted).toMatchObject({
            repo: "stella/stella",
            pr: 123,
            head: HEAD,
          });
          if (accepted !== undefined) {
            expect(Date.parse(accepted.at)).toBeLessThanOrEqual(
              Number(readFileSync(marker, "utf-8")),
            );
          }
        }
      }
      if (scenario === "ready") {
        expect(mutations().at(0)?.join(" ")).toContain(
          "expectedHeadOid:$sha,jump:false",
        );
        const repeated = run();
        expect(repeated.exitCode).toBe(1);
        expect(repeated.stderr.toString()).toContain("no unused JUMP_RESET");
        expect(mutations()).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
