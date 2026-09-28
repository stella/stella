// The publisher's orchestration against a fake GitHub: what it writes, and
// above all when it dequeues. Dequeuing is enforce mode's primary eviction,
// so these pin that it removes only a confirmed offender, re-read right
// before the mutation, and never in shadow mode or a dry run.

import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  parseReviewGateConfig,
  type GateOutput,
  type PublishedRun,
  type QueueEntry,
  type QueueRecheck,
  type RunIdentity,
} from "./review-gate";
import {
  createRun,
  evaluateGroupTarget,
  evaluatePullRequestTarget,
  type Gateway,
  type PullRequestRead,
} from "./review-gate-github";

const OPENED = "2026-09-28T10:00:00Z";
const GROUP_SHA = "c".repeat(40);
const headOf = (number: number): string => String(number).padStart(40, "0");

const config = (mode: "shadow" | "enforce") =>
  parseReviewGateConfig({
    mode,
    reviewers: [
      {
        name: "PerPush",
        done: { commit_status: { context: "PerPush", states: ["success"] } },
        scope: "head",
        timeout_minutes: 20,
      },
    ],
  });

const THREAD = {
  url: "https://github.com/o/r/pull/1#discussion_r1",
  path: null,
};

const pullRequest = (
  number: number,
  overrides: Partial<PullRequestRead> = {},
): PullRequestRead => ({
  id: `PR_${number}`,
  number,
  headSha: headOf(number),
  baseRefName: "main",
  queued: true,
  readAt: OPENED,
  isDraft: false,
  author: "pr-author",
  readyAt: OPENED,
  files: ["apps/api/src/index.ts"],
  reviews: [],
  reactions: [],
  comments: [],
  statuses: [{ context: "PerPush", state: "SUCCESS" }],
  checkRuns: [],
  threads: { complete: true, unresolved: [] },
  headClockStartedAt: OPENED,
  ...overrides,
});

type Call =
  | { kind: "revalidate"; number: number }
  | { kind: "write"; sha: string; output: GateOutput; identity: RunIdentity }
  | { kind: "dequeue"; id: string };

const fakeGateway = ({
  pullRequests,
  fresh = {},
  queue = [],
}: {
  pullRequests: readonly PullRequestRead[];
  // What a re-read right before acting returns; defaults to the first read.
  fresh?: Record<number, Partial<QueueRecheck>>;
  queue?: readonly QueueEntry[];
}) => {
  const calls: Call[] = [];
  const byNumber = new Map(pullRequests.map((read) => [read.number, read]));
  const read = (number: number): PullRequestRead =>
    byNumber.get(number) ?? expect.unreachable(`no fixture for #${number}`);
  const gateway: Gateway = {
    readPullRequest: read,
    revalidate: (number) => {
      calls.push({ kind: "revalidate", number });
      const { headSha, queued, threads } = read(number);
      return { headSha, queued, threads, ...fresh[number] };
    },
    readQueue: () => queue,
    readRuns: (): readonly PublishedRun[] => [],
    writeRun: (sha, output, identity) => {
      calls.push({ kind: "write", sha, output, identity });
    },
    pullRequestsForSha: () => [],
    discoverOpenPullRequests: () => [],
    dequeue: (id) => {
      calls.push({ kind: "dequeue", id });
    },
  };
  return { gateway, calls };
};

const kinds = (calls: readonly Call[]) => calls.map(({ kind }) => kind);
const dequeued = (calls: readonly Call[]) =>
  calls.flatMap((call) => (call.kind === "dequeue" ? [call.id] : []));

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => undefined);
});

describe("dequeue of a queued pull request", () => {
  const offender = pullRequest(1, {
    threads: { complete: true, unresolved: [THREAD] },
  });

  test("enforce: publishes the failure, re-reads, then dequeues the confirmed offender", () => {
    const { gateway, calls } = fakeGateway({ pullRequests: [offender] });
    evaluatePullRequestTarget(
      createRun(gateway, config("enforce"), {
        baseBranch: "main",
        dryRun: false,
      }),
      1,
    );
    expect(kinds(calls)).toEqual(["write", "revalidate", "dequeue"]);
    expect(dequeued(calls)).toEqual(["PR_1"]);
  });

  test.each([
    ["left the queue", { queued: false }],
    ["was pushed to", { headSha: "f".repeat(40) }],
    [
      "had its threads resolved",
      { threads: { complete: true, unresolved: [] } },
    ],
  ] as const)(
    "enforce: no dequeue when the re-read shows it %s",
    (_, change) => {
      const { gateway, calls } = fakeGateway({
        pullRequests: [offender],
        fresh: { 1: change },
      });
      evaluatePullRequestTarget(
        createRun(gateway, config("enforce"), {
          baseBranch: "main",
          dryRun: false,
        }),
        1,
      );
      expect(dequeued(calls)).toEqual([]);
    },
  );

  test("shadow: publishes the failure and never re-reads for, or performs, a dequeue", () => {
    const { gateway, calls } = fakeGateway({ pullRequests: [offender] });
    evaluatePullRequestTarget(
      createRun(gateway, config("shadow"), {
        baseBranch: "main",
        dryRun: false,
      }),
      1,
    );
    expect(kinds(calls)).toEqual(["write"]);
  });

  test("dry run: confirms but neither writes nor dequeues", () => {
    const { gateway, calls } = fakeGateway({ pullRequests: [offender] });
    evaluatePullRequestTarget(
      createRun(gateway, config("enforce"), {
        baseBranch: "main",
        dryRun: true,
      }),
      1,
    );
    expect(kinds(calls)).toEqual(["revalidate"]);
  });

  test("a pull request that is not queued is never dequeued", () => {
    const { gateway, calls } = fakeGateway({
      pullRequests: [{ ...offender, queued: false }],
    });
    evaluatePullRequestTarget(
      createRun(gateway, config("enforce"), {
        baseBranch: "main",
        dryRun: false,
      }),
      1,
    );
    expect(dequeued(calls)).toEqual([]);
  });
});

describe("dequeue from a merge group", () => {
  const queue: readonly QueueEntry[] = [
    { position: 1, headSha: "a".repeat(40), pullRequest: 1 },
    { position: 2, headSha: GROUP_SHA, pullRequest: 2 },
  ];

  test("enforce: the group fails and only its offending pull request leaves", () => {
    const { gateway, calls } = fakeGateway({
      pullRequests: [
        pullRequest(1),
        pullRequest(2, { threads: { complete: true, unresolved: [THREAD] } }),
      ],
      queue,
    });
    evaluateGroupTarget(
      createRun(gateway, config("enforce"), {
        baseBranch: "main",
        dryRun: false,
      }),
      GROUP_SHA,
    );
    const write = calls.find((call) => call.kind === "write");
    expect(write?.kind === "write" && write.sha).toBe(GROUP_SHA);
    expect(write?.kind === "write" && write.output.conclusion).toBe("failure");
    expect(write?.kind === "write" && write.identity).toMatchObject({
      kind: "group",
      members: [1, 2],
    });
    expect(dequeued(calls)).toEqual(["PR_2"]);
  });

  test("a clean group publishes success and dequeues nothing", () => {
    const { gateway, calls } = fakeGateway({
      pullRequests: [pullRequest(1), pullRequest(2)],
      queue,
    });
    evaluateGroupTarget(
      createRun(gateway, config("enforce"), {
        baseBranch: "main",
        dryRun: false,
      }),
      GROUP_SHA,
    );
    const write = calls.find((call) => call.kind === "write");
    expect(write?.kind === "write" && write.output.conclusion).toBe("success");
    expect(dequeued(calls)).toEqual([]);
  });
});
