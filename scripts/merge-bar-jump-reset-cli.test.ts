import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createJumpResetStore } from "./merge-bar-jump-reset";

const HEAD = "a".repeat(40);
const GROUP = "b".repeat(40);
const AT = "2026-10-07T10:00:00Z";
const cancelled = {
  conclusion: "cancelled",
  completed_at: "2026-10-07T10:00:01Z",
};

test.each([
  { scenario: "cancelled", status: "JUMP_RESET", exit: 0 },
  { scenario: "reserved", status: "JUMP_RESET", exit: 0 },
  { scenario: "failure", status: "not-reset", exit: 0 },
  { scenario: "unknown", status: "not-reset", exit: 0 },
  { scenario: "later-manual", status: "not-reset", exit: 0 },
  // Unreadable evidence is unavailable: classification fails closed.
  { scenario: "truncated", status: "not-reset", exit: 0 },
  { scenario: "duplicated-page", status: "not-reset", exit: 0 },
  { scenario: "head-moved", status: "", exit: 1 },
  { scenario: "dry-unseeded", status: "not-reset", exit: 0 },
])(
  "classifies pinned ejections with complete job pages: $scenario",
  ({ scenario, status, exit }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "jump-classify-cli-"));
    try {
      const state = path.join(directory, "state");
      const store = createJumpResetStore(path.join(state, "jump-resets"));
      if (scenario !== "dry-unseeded") {
        expect(
          store
            .recordJump({ repo: "stella/stella", pr: 123, head: HEAD, at: AT })
            .isOk(),
        ).toBe(true);
      }
      if (scenario === "reserved") {
        expect(store.reserve(`stella/stella#123@${HEAD}`).isOk()).toBe(true);
      }
      const calls = path.join(directory, "calls.jsonl");
      const executable = path.join(directory, "gh");
      const fixture = path.join(directory, "fixture.json");
      writeFileSync(
        fixture,
        JSON.stringify({
          scenario,
          calls,
          pull: {
            id: "PR_fixture",
            number: 123,
            title: "fix: queue recovery",
            state: "OPEN",
            isDraft: false,
            isCrossRepository: false,
            mergeable: "MERGEABLE",
            headRefOid: scenario === "head-moved" ? GROUP : HEAD,
            baseRefName: "main",
            autoMergeRequest: null,
            mergeQueueEntry: null,
          },
          timeline: [
            { __typename: "PullRequestCommit", commit: { oid: HEAD } },
            {
              __typename: "RemovedFromMergeQueueEvent",
              createdAt: AT,
              reason: "failed_checks",
              beforeCommit: { oid: GROUP },
            },
            ...(scenario === "later-manual"
              ? [
                  {
                    __typename: "RemovedFromMergeQueueEvent",
                    createdAt: "2026-10-07T10:01:00Z",
                    reason: "manual",
                    beforeCommit: { oid: GROUP },
                  },
                ]
              : []),
          ],
          group: GROUP,
          cancelled,
        }),
      );
      writeFileSync(
        executable,
        `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const f = JSON.parse(readFileSync(${JSON.stringify(fixture)}, "utf8"));
const args = Bun.argv.slice(2);
appendFileSync(f.calls, JSON.stringify(args) + "\\n");
const endpoint = args.at(1) ?? "";
if (endpoint === "graphql") {
  if (args.some(a => a.includes("timelineItems"))) console.log(JSON.stringify(f.timeline));
  else console.log(JSON.stringify({ data: { repository: { pullRequest: f.pull } } }));
} else if (endpoint.includes("actions/runs?event=merge_group")) {
  console.log(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 7, head_sha: f.group, event: "merge_group" }] }));
} else if (endpoint.includes("actions/runs/7/jobs?filter=latest&per_page=100&page=")) {
  const second = endpoint.endsWith("page=2");
  const last = f.scenario === "failure" ? { ...f.cancelled, conclusion: "failure" } : f.scenario === "unknown" ? { ...f.cancelled, conclusion: null } : f.cancelled;
  console.log(JSON.stringify({ total_count: 101, jobs: second ? (f.scenario === "truncated" ? [] : [{ ...last, id: f.scenario === "duplicated-page" ? 1 : 101 }]) : Array.from({length: 100}, (_, i) => ({ ...f.cancelled, id: i + 1 })) }));
} else { console.error("Unexpected fake gh request: " + JSON.stringify(args)); process.exit(96); }
`,
      );
      chmodSync(executable, 0o700);
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "scripts/merge-bar.ts",
          "--classify-ejection",
          "123",
          "--expected-head-sha",
          HEAD,
          ...(scenario === "dry-unseeded" ? ["--dry-run"] : []),
        ],
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
          NODE_ENV: "test",
          STELLA_LOCAL_DEV: "1",
          STELLA_MERGE_BAR_TEST_SKIP_FRESHNESS: "1",
          STELLA_MERGE_BAR_STATE_DIR: state,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(exit);
      if (scenario === "truncated" || scenario === "duplicated-page") {
        expect(result.stderr.toString()).toContain(
          "jump-reset evidence unavailable",
        );
      }
      if (exit === 0) {
        expect(JSON.parse(result.stdout.toString())).toMatchObject({
          status,
          head: HEAD,
          retry: scenario === "reserved" ? "reserved" : "available",
        });
      }
      const requests: string[][] = readFileSync(calls, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        requests.some((args) =>
          args.some((arg) =>
            /enqueuePullRequest|enablePullRequestAutoMerge|STELLA_MERGE_HOLD|rules\/branches/u.test(
              arg,
            ),
          ),
        ),
      ).toBe(false);
      if (scenario !== "head-moved" && scenario !== "later-manual") {
        expect(
          requests.some((args) =>
            args.some((arg) =>
              arg.includes("jobs?filter=latest&per_page=100&page=2"),
            ),
          ),
        ).toBe(true);
      }
      if (scenario === "later-manual") {
        expect(
          requests.some((args) =>
            args.some((arg) => arg.includes("actions/runs")),
          ),
        ).toBe(false);
      }
      if (scenario === "dry-unseeded") {
        expect(existsSync(state)).toBe(false);
      } else {
        expect(readdirSync(path.join(state, "jump-resets"))).toEqual(
          scenario === "reserved" ? ["jumps", "rearms"] : ["jumps"],
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
