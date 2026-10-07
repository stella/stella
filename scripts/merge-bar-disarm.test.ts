import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { disarmPullRequest, parseOptions } from "./merge-bar";

const state = ({ armed = false, queued = false } = {}) => ({
  id: "PR_fixture",
  headRefOid: "verified-head",
  updatedAt: "2026-10-04T18:00:00Z",
  autoMergeRequest: armed ? { enabledAt: "2026-10-04T19:00:00Z" } : null,
  mergeQueueEntry: queued ? { id: "MQ_fixture" } : null,
});

describe("holding pull requests", () => {
  test.each([
    { armed: false, queued: false },
    { armed: true, queued: false },
    { armed: false, queued: true },
    { armed: true, queued: true },
  ])("clears both independent handoffs and is idempotent: %j", (initial) => {
    let armed = initial.armed;
    let queued = initial.queued;
    const writes: string[] = [];
    const gateway = {
      readArmState: () => state({ armed, queued }),
      mutateHandoff: (query: string) => {
        writes.push(query);
        if (query.includes("disablePullRequestAutoMerge")) {
          armed = false;
        }
        if (query.includes("dequeuePullRequest")) {
          queued = false;
        }
        return {};
      },
    };
    expect(disarmPullRequest({ gateway, dryRun: false }).unwrap()).toEqual({
      status: "disarmed",
      id: "PR_fixture",
      headSha: "verified-head",
    });
    expect(armed).toBe(false);
    expect(queued).toBe(false);
    expect(writes).toHaveLength(Number(initial.armed) + Number(initial.queued));
    const writeCount = writes.length;
    expect(disarmPullRequest({ gateway, dryRun: false }).isOk()).toBe(true);
    expect(writes).toHaveLength(writeCount);
  });

  test("dequeues auto-merge that enqueues during disable", () => {
    let current = state({ armed: true });
    const result = disarmPullRequest({
      dryRun: false,
      gateway: {
        readArmState: () => current,
        mutateHandoff: (query) => {
          current = state({
            queued: query.includes("disablePullRequestAutoMerge"),
          });
          return {};
        },
      },
    });
    expect(result.isOk()).toBe(true);
    expect(current).toEqual(state());
  });

  test("dry run performs no writes", () => {
    const result = disarmPullRequest({
      dryRun: true,
      gateway: {
        readArmState: () => state({ armed: true, queued: true }),
        mutateHandoff: () => {
          throw new Error("unexpected dry-run mutation");
        },
      },
    });
    expect(result.unwrap()).toEqual({ status: "dry-run", id: "PR_fixture" });
  });

  test.each(["disablePullRequestAutoMerge", "dequeuePullRequest"])(
    "propagates a %s failure without reporting a receipt",
    (operation) => {
      const result = disarmPullRequest({
        dryRun: false,
        gateway: {
          readArmState: () =>
            state({
              armed: operation === "disablePullRequestAutoMerge",
              queued: true,
            }),
          mutateHandoff: () => {
            throw new Error(`${operation} refused`);
          },
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(`${operation} refused`);
      }
    },
  );

  test.each([{ armed: true }, { queued: true }])(
    "refuses an uncleared final state: %j",
    (initial) => {
      const result = disarmPullRequest({
        dryRun: false,
        gateway: {
          readArmState: () => state(initial),
          mutateHandoff: () => ({}),
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain("Disarm verification failed");
      }
    },
  );

  test.each([
    { head: "a".repeat(40), rollup: "SUCCESS", state: "OPEN" },
    { head: "b".repeat(40), rollup: "FAILURE", state: "OPEN" },
    { head: "a".repeat(40), rollup: "FAILURE", state: "CLOSED" },
  ])(
    "pinned disarm refuses moved, recovered or closed heads: %j",
    (current) => {
      const result = disarmPullRequest({
        dryRun: false,
        expectedHeadSha: "a".repeat(40),
        gateway: {
          readArmState: () => ({
            ...state({ armed: true }),
            state: current.state,
            headRefOid: current.head,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: current.head,
                    statusCheckRollup: { state: current.rollup },
                  },
                },
              ],
            },
          }),
          mutateHandoff: () => {
            throw new Error("unexpected write on refused head");
          },
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(
          "expected head changed or its rollup is no longer red",
        );
      }
    },
  );

  test.each([
    { queued: false, change: "head", at: "disable" },
    { queued: true, change: "head", at: "disable" },
    { queued: false, change: "rollup", at: "disable" },
    { queued: true, change: "rollup", at: "disable" },
    { queued: false, change: "rollup-unavailable", at: "disable" },
    { queued: true, change: "rollup-unavailable", at: "disable" },
    { queued: true, change: "head", at: "dequeue" },
    { queued: true, change: "rollup", at: "dequeue" },
    { queued: false, change: "head", at: "final-read" },
    { queued: false, change: "rollup", at: "final-read" },
  ])(
    "reports a changed disarm for queued and unqueued races: %j",
    (scenario) => {
      let armed = true;
      let queued = scenario.queued;
      let head = "a".repeat(40);
      let rollup: string | null = "FAILURE";
      let reads = 0;
      const writes: string[] = [];
      const change = () => {
        if (scenario.change === "head") {
          head = "b".repeat(40);
        } else if (scenario.change === "rollup-unavailable") {
          rollup = null;
        } else {
          rollup = "SUCCESS";
        }
      };
      const result = disarmPullRequest({
        dryRun: false,
        expectedHeadSha: "a".repeat(40),
        gateway: {
          readArmState: () => {
            reads += 1;
            if (scenario.at === "final-read" && reads === 3) {
              change();
            }
            return {
              ...state({ armed, queued }),
              state: "OPEN",
              headRefOid: head,
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: head,
                      statusCheckRollup:
                        rollup === null ? null : { state: rollup },
                    },
                  },
                ],
              },
            };
          },
          mutateHandoff: (query) => {
            writes.push(query);
            if (query.includes("disablePullRequestAutoMerge")) {
              armed = false;
              if (scenario.at === "disable") {
                change();
              }
            } else {
              queued = false;
              if (scenario.at === "dequeue") {
                change();
              }
            }
            return {};
          },
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(
          "disarmed, but the PR changed during the disarm",
        );
        expect(result.error.message).toContain("review and re-arm manually");
      }
      expect(armed).toBe(false);
      expect(writes).toHaveLength(scenario.at === "dequeue" ? 2 : 1);
      expect(
        writes.some((query) => query.includes("enablePullRequestAutoMerge")),
      ).toBe(false);
    },
  );

  test("pinned disarm accepts the expected red head", () => {
    let armed = true;
    const head = "a".repeat(40);
    const result = disarmPullRequest({
      dryRun: false,
      expectedHeadSha: head,
      gateway: {
        readArmState: () => ({
          ...state({ armed }),
          state: "OPEN",
          headRefOid: head,
          commits: {
            nodes: [
              {
                commit: { oid: head, statusCheckRollup: { state: "FAILURE" } },
              },
            ],
          },
        }),
        mutateHandoff: () => {
          armed = false;
          return {};
        },
      },
    });
    expect(result.isOk()).toBe(true);
    expect(armed).toBe(false);
    expect(
      parseOptions(["--disarm", "123", "--expected-head-sha", head]),
    ).toMatchObject({ mode: "disarm", expectedHeadSha: head });
  });

  test("disarm is explicit and rejects jump", () => {
    expect(
      parseOptions(["--disarm", "123", "--repo", "stella/folio"]).mode,
    ).toBe("disarm");
    expect(parseOptions(["123"]).mode).toBe("merge");
    expect(() => parseOptions(["--disarm", "123", "--jump"])).toThrow(
      "--disarm cannot be combined with --jump",
    );
  });
});

describe("changed disarm CLI outcome", () => {
  test.each([false, true])(
    "exits non-success after the head moves, queued=%j",
    (queued) => {
      const directory = mkdtempSync(path.join(tmpdir(), "merge-bar-disarm-"));
      try {
        const head = "a".repeat(40);
        const snapshot = (sha: string, armed: boolean) => ({
          ...state({ armed, queued }),
          state: "OPEN",
          headRefOid: sha,
          commits: {
            nodes: [
              { commit: { oid: sha, statusCheckRollup: { state: "FAILURE" } } },
            ],
          },
        });
        const executable = path.join(directory, "gh");
        const calls = path.join(directory, "calls.jsonl");
        const marker = path.join(directory, "disabled");
        const fixturePath = path.join(directory, "fixture.json");
        writeFileSync(
          fixturePath,
          JSON.stringify({
            calls,
            marker,
            before: {
              data: { repository: { pullRequest: snapshot(head, true) } },
            },
            after: {
              data: {
                repository: { pullRequest: snapshot("b".repeat(40), false) },
              },
            },
          }),
        );
        writeFileSync(
          executable,
          `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf-8"));
const args = Bun.argv.slice(2);
appendFileSync(fixture.calls, JSON.stringify(args) + "\\n");
if (args.some(arg => arg.includes("disablePullRequestAutoMerge"))) {
  writeFileSync(fixture.marker, "disabled");
  console.log(JSON.stringify({data:{}}));
} else {
  const query = args.find(arg => arg.startsWith("query=")) || "";
  const snapshot = existsSync(fixture.marker) ? fixture.after : fixture.before;
  if (!query.includes("id state headRefOid")) delete snapshot.data.repository.pullRequest.state;
  if (!query.includes("commits(last:1)")) delete snapshot.data.repository.pullRequest.commits;
  console.log(JSON.stringify(snapshot));
}
`,
        );
        chmodSync(executable, 0o755);
        const result = Bun.spawnSync(
          [
            process.execPath,
            "scripts/merge-bar.ts",
            "--disarm",
            "123",
            "--expected-head-sha",
            head,
          ],
          {
            env: {
              ...process.env,
              PATH: directory + path.delimiter + process.env["PATH"],
              NODE_ENV: "test",
              STELLA_LOCAL_DEV: "1",
              STELLA_MERGE_BAR_TEST_SKIP_FRESHNESS: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(result.exitCode, result.stderr.toString()).toBe(2);
        expect(result.stderr.toString()).toContain(
          "disarmed, but the PR changed during the disarm",
        );
        expect(result.stdout.toString()).not.toContain("DISARMED ");
        const recorded: string[][] = readFileSync(calls, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const reads = recorded.filter((args) =>
          args.some((arg) => arg.startsWith("query=query(")),
        );
        expect(reads).toHaveLength(2);
        for (const args of reads) {
          const query = args.find((arg) => arg.startsWith("query="));
          expect(query).toContain("id state headRefOid");
          expect(query).toContain(
            "commits(last:1) { nodes { commit { oid statusCheckRollup { state } } } }",
          );
        }
        expect(
          recorded.filter((args) =>
            args.some((arg) => arg.includes("disablePullRequestAutoMerge")),
          ),
        ).toHaveLength(1);
        expect(
          recorded.some((args) =>
            args.some(
              (arg) =>
                arg.includes("enablePullRequestAutoMerge") ||
                arg.includes("dequeuePullRequest"),
            ),
          ),
        ).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
