// The publisher's orchestration against a fake GitHub: what it writes, and
// above all when it dequeues. Dequeuing is enforce mode's primary eviction,
// so these pin that it removes only a confirmed offender, re-read right
// before the mutation, and never in shadow mode or a dry run.

import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  fail,
  latestRun,
  outputStatus,
  parseReviewGateConfig,
  type GateOutput,
  type PublishedRun,
  type QueueEntry,
  type QueueRecheck,
  type RunIdentity,
} from "./review-gate";
import {
  createGateway,
  createRun,
  evaluateGroupTarget,
  evaluatePullRequestTarget,
  guardedPullRequest,
  parsePullRequest,
  publish,
  type Gateway,
  type PullRequestRead,
  type RunGh,
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
  statuses: [{ context: "PerPush", state: "SUCCESS", description: null }],
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
  runReads = [],
  failingReads = [],
  failingDequeue = false,
}: {
  pullRequests: readonly PullRequestRead[];
  // What a re-read right before acting returns; defaults to the first read.
  fresh?: Record<number, Partial<QueueRecheck>>;
  queue?: readonly QueueEntry[];
  // Successive answers to reading a commit's gate runs; then none.
  runReads?: readonly (readonly PublishedRun[])[];
  // Pull requests whose full read fails.
  failingReads?: readonly number[];
  failingDequeue?: boolean;
}) => {
  const calls: Call[] = [];
  const byNumber = new Map(pullRequests.map((read) => [read.number, read]));
  const read = (number: number): PullRequestRead =>
    byNumber.get(number) ?? expect.unreachable(`no fixture for #${number}`);
  const pendingRunReads = [...runReads];
  const gateway: Gateway = {
    readPullRequest: (number) =>
      failingReads.includes(number)
        ? fail("GraphQL errors: something went wrong")
        : read(number),
    revalidate: (number) => {
      calls.push({ kind: "revalidate", number });
      const { headSha, queued, threads } = read(number);
      return { headSha, queued, threads, ...fresh[number] };
    },
    readQueue: () => queue,
    readRuns: (): readonly PublishedRun[] => pendingRunReads.shift() ?? [],
    writeRun: (sha, output, identity) => {
      calls.push({ kind: "write", sha, output, identity });
    },
    restampRun: () => expect.unreachable("no run to re-stamp"),
    readHead: (number) => headOf(number),
    pullRequestsForSha: () => [],
    discoverOpenPullRequests: () => [],
    dequeue: (id) => {
      calls.push({ kind: "dequeue", id });
      if (failingDequeue) {
        fail("GraphQL errors: dequeue refused");
      }
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

describe("a head's check rollup", () => {
  const parse = (commit: unknown) =>
    parsePullRequest(
      {
        id: "PR_1",
        headRefOid: headOf(1),
        baseRefName: "main",
        isDraft: false,
        author: { login: "pr-author" },
        mergeQueueEntry: null,
        createdAt: OPENED,
        files: { totalCount: 0, nodes: [] },
        timelineItems: { nodes: [] },
        commits: { nodes: [{ commit }] },
        reviews: { nodes: [] },
        reactions: { nodes: [] },
        comments: { nodes: [] },
      },
      {
        number: 1,
        threads: { complete: true, unresolved: [] },
        headClockStartedAt: null,
        readAt: OPENED,
      },
    );

  test("a new head with a null or empty rollup has no checks yet", () => {
    for (const commit of [
      { statusCheckRollup: null },
      {
        statusCheckRollup: {
          contexts: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    ]) {
      const result = parse(commit);
      expect(result.statuses).toEqual([]);
      expect(result.checkRuns).toEqual([]);
      expect(result.headSha).toBe(headOf(1));
    }
  });

  test("malformed commits and missing or non-null rollups still fail the read", () => {
    for (const commit of [
      null,
      {},
      { statusCheckRollup: false },
      { statusCheckRollup: {} },
      { statusCheckRollup: { contexts: { nodes: null } } },
      { statusCheckRollup: { contexts: { nodes: {} } } },
      { statusCheckRollup: { contexts: { nodes: [] } } },
    ]) {
      expect(() => parse(commit)).toThrow(/Expected (object|list) at/u);
    }
  });
});

describe("reading GitHub", () => {
  const HEAD = headOf(7);
  const status = (context: string) => ({
    __typename: "StatusContext",
    context,
    state: "SUCCESS",
    description: null,
  });
  const page = (nodes: readonly unknown[], after: string | null) => ({
    pageInfo: { hasNextPage: after !== null, endCursor: after },
    nodes,
  });
  const noRuns = { checkSuites: { totalCount: 0, nodes: [] } };
  const pullRequestNode = (contexts: unknown) => ({
    id: "PR_7",
    number: 7,
    headRefOid: HEAD,
    baseRefName: "main",
    isDraft: false,
    createdAt: OPENED,
    author: { login: "pr-author" },
    autoMergeRequest: null,
    mergeQueueEntry: null,
    files: { totalCount: 0, nodes: [] },
    reviews: { nodes: [] },
    reactions: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    commits: {
      nodes: [{ commit: { statusCheckRollup: { contexts }, ...noRuns } }],
    },
    reviewThreads: page([], null),
  });
  // Answers each gh call by what it asks for, and records the asks.
  const fakeGh = (answer: (query: string) => unknown) => {
    const asked: string[] = [];
    const gh: RunGh = (args) => {
      const query = args.find((arg) => arg.startsWith("query="));
      const key = query ?? args.join(" ");
      asked.push(key);
      return JSON.stringify(answer(key));
    };
    return { gh, asked };
  };

  test("finds a reviewer's status past the first page of a busy head", () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      status(`ci-${index}`),
    );
    const { gh, asked } = fakeGh((query) =>
      query.includes("contexts(first: 100, after: $cursor)")
        ? {
            data: {
              repository: {
                object: {
                  statusCheckRollup: {
                    contexts: page([status("CodeRabbit")], null),
                  },
                },
              },
            },
          }
        : {
            data: {
              repository: {
                pullRequest: pullRequestNode(page(first, "cursor-1")),
              },
            },
          },
    );
    const read = createGateway("o/r", "main", gh).readPullRequest(7);
    expect(read.statuses).toHaveLength(101);
    expect(read.statuses.at(-1)?.context).toBe("CodeRabbit");
    expect(asked).toHaveLength(2);
  });

  test("a head with more checks than the pages it reads fails the read", () => {
    const { gh } = fakeGh((query) =>
      query.includes("contexts(first: 100, after: $cursor)")
        ? {
            data: {
              repository: {
                object: {
                  statusCheckRollup: {
                    contexts: page([status("more")], "cursor-n"),
                  },
                },
              },
            },
          }
        : {
            data: {
              repository: {
                pullRequest: pullRequestNode(page([], "cursor-1")),
              },
            },
          },
    );
    expect(() => createGateway("o/r", "main", gh).readPullRequest(7)).toThrow(
      /more than 500 checks and statuses/u,
    );
  });

  test("finds a fork's pull request by its head when GitHub associates none", () => {
    const { gh, asked } = fakeGh((query) =>
      query.includes("/pulls")
        ? []
        : {
            data: {
              repository: {
                pullRequests: page(
                  [8, 7].map((number) => ({
                    number,
                    isDraft: false,
                    headRefOid: headOf(number),
                    autoMergeRequest: null,
                    mergeQueueEntry: null,
                    commits: { nodes: [{ commit: noRuns }] },
                  })),
                  null,
                ),
              },
            },
          },
    );
    expect(createGateway("o/r", "main", gh).pullRequestsForSha(HEAD)).toEqual([
      7,
    ]);
    expect(asked).toHaveLength(2);
  });

  test("an associated open pull request needs no discovery", () => {
    const { gh, asked } = fakeGh(() => [
      { number: 7, state: "open" },
      { number: 3, state: "closed" },
    ]);
    expect(createGateway("o/r", "main", gh).pullRequestsForSha(HEAD)).toEqual([
      7,
    ]);
    expect(asked).toHaveLength(1);
  });
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

  test("enforce: a failed dequeue keeps the failure standing and still fails its group", () => {
    const group = "a".repeat(40);
    const { gateway, calls } = fakeGateway({
      pullRequests: [offender],
      queue: [{ position: 1, headSha: group, pullRequest: 1 }],
      failingDequeue: true,
    });
    const state = createRun(gateway, config("enforce"), {
      baseBranch: "main",
      dryRun: false,
    });
    guardedPullRequest(state, 1, { withGroups: true });
    const writes = calls.flatMap((call) =>
      call.kind === "write" ? [call] : [],
    );
    expect(writes.map(({ sha, output }) => [sha, output.conclusion])).toEqual([
      [headOf(1), "failure"],
      [group, "failure"],
    ]);
    expect(dequeued(calls)).toEqual(["PR_1"]);
    expect(state.failures).toEqual([
      "#1: dequeue failed: GraphQL errors: dequeue refused",
    ]);
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

describe("publishing races", () => {
  const offender = pullRequest(1, {
    readAt: "2026-09-28T10:05:00Z",
    threads: { complete: true, unresolved: [THREAD] },
  });
  const run = (
    id: number,
    observedAt: string,
    output: GateOutput,
  ): PublishedRun => ({
    id,
    identity: { kind: "pr", pullRequest: 1, observedAt },
    status: output.conclusion === "pending" ? "in_progress" : "completed",
    conclusion: output.conclusion === "pending" ? null : output.conclusion,
    title: output.title,
    summary: output.summary,
    startedAt: observedAt,
  });
  const success: GateOutput = {
    conclusion: "success",
    title: "Reviews complete, no unresolved threads",
    summary: "- ✅",
  };

  test("replaying an unchanged observation performs no write", () => {
    const { gateway, calls } = fakeGateway({
      pullRequests: [],
      runReads: [[run(1, OPENED, success)]],
    });
    publish(
      createRun(gateway, config("shadow"), {
        baseBranch: "main",
        dryRun: false,
      }),
      headOf(1),
      success,
      { kind: "pr", pullRequest: 1, observedAt: OPENED },
    );
    expect(calls).toEqual([]);
  });

  test("a changed verdict performs one write", () => {
    for (const output of [
      { ...success, conclusion: "failure" },
      { ...success, title: "Changed title" },
      { ...success, summary: "Changed summary" },
    ] satisfies GateOutput[]) {
      const { gateway, calls } = fakeGateway({
        pullRequests: [],
        runReads: [[run(1, OPENED, success)]],
      });
      const identity = {
        kind: "pr",
        pullRequest: 1,
        observedAt: "2026-09-28T10:01:00Z",
      } as const;
      publish(
        createRun(gateway, config("shadow"), {
          baseBranch: "main",
          dryRun: false,
        }),
        headOf(1),
        output,
        identity,
      );
      expect(calls).toEqual([
        { kind: "write", sha: headOf(1), output, identity },
      ]);
    }
  });

  test("a newer verdict overtaken by an older write is re-posted after the write", () => {
    const { gateway, calls } = fakeGateway({
      pullRequests: [offender],
      runReads: [
        // At decision time only an older success is visible.
        [run(1, "2026-09-28T10:00:00Z", success)],
        // After writing, a racing writer's older success landed last.
        [
          run(1, "2026-09-28T10:00:00Z", success),
          run(2, "2026-09-28T10:05:00Z", {
            conclusion: "failure",
            title: "1 unresolved review thread",
            summary: "- ❌",
          }),
          run(3, "2026-09-28T10:03:00Z", success),
        ],
      ],
    });
    evaluatePullRequestTarget(
      createRun(gateway, config("shadow"), {
        baseBranch: "main",
        dryRun: false,
      }),
      1,
    );
    const writes = calls.flatMap((call) =>
      call.kind === "write" ? [call] : [],
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]?.output.conclusion).toBe("failure");
    expect(writes[1]?.identity.observedAt).toBe("2026-09-28T10:05:00Z");
  });
});

describe("a failed read", () => {
  test("still replaces the verdict with a blocking pending, on the head the event named", () => {
    const { gateway, calls } = fakeGateway({
      pullRequests: [pullRequest(1)],
      failingReads: [1],
    });
    const state = createRun(gateway, config("shadow"), {
      baseBranch: "main",
      dryRun: false,
    });
    state.eventHeads.set(1, "e".repeat(40));
    guardedPullRequest(state, 1, { withGroups: true });
    const write = calls.find((call) => call.kind === "write");
    expect(write?.kind === "write" && write.sha).toBe("e".repeat(40));
    expect(write?.kind === "write" && write.output.conclusion).toBe("pending");
    expect(state.failures).toHaveLength(1);
  });

  test("without an event head, falls back to looking the head up", () => {
    const { gateway, calls } = fakeGateway({
      pullRequests: [pullRequest(1)],
      failingReads: [1],
    });
    const state = createRun(gateway, config("shadow"), {
      baseBranch: "main",
      dryRun: false,
    });
    guardedPullRequest(state, 1, { withGroups: true });
    const write = calls.find((call) => call.kind === "write");
    expect(write?.kind === "write" && write.sha).toBe(headOf(1));
  });
});

describe("overlapping publishers for one commit", () => {
  const SHA = headOf(1);
  const at = (minutes: number): string =>
    new Date(Date.parse(OPENED) + minutes * 60_000).toISOString();
  const verdict = (conclusion: GateOutput["conclusion"]): GateOutput => ({
    conclusion,
    title: conclusion,
    summary: `${conclusion} summary`,
  });
  const identity = (minutes: number): RunIdentity => ({
    kind: "pr",
    pullRequest: 1,
    observedAt: at(minutes),
  });

  // One commit's gate runs, shared by every publisher. `interrupt` holds,
  // per publisher, what other publishers complete right before its Nth
  // write lands: the interleavings a per-run concurrency group allows.
  const github = (initial: readonly PublishedRun[] = []) => {
    const runs: PublishedRun[] = [...initial];
    let nextId = Math.max(0, ...runs.map(({ id }) => id)) + 1;
    const publisher = (interrupt: Record<number, () => void> = {}) => {
      let writes = 0;
      const beforeWrite = () => {
        writes += 1;
        interrupt[writes]?.();
      };
      const { gateway } = fakeGateway({ pullRequests: [] });
      return createRun(
        {
          ...gateway,
          readRuns: () => runs.map((run) => ({ ...run })),
          writeRun: (_sha, output, stamp) => {
            beforeWrite();
            const { status, conclusion } = outputStatus(output);
            runs.push({
              id: nextId,
              identity: stamp,
              status,
              conclusion,
              title: output.title,
              summary: output.summary,
              startedAt: at(0),
            });
            nextId += 1;
          },
          restampRun: (id, stamp) => {
            beforeWrite();
            const run = runs.find((candidate) => candidate.id === id);
            if (run !== undefined) {
              run.identity = stamp;
            }
          },
        },
        config("shadow"),
        { baseBranch: "main", dryRun: false },
      );
    };
    return { publisher, latest: () => latestRun(runs) };
  };

  test("three writers: a stale re-post landing after the newest failure is repaired", () => {
    const { publisher, latest } = github();
    const newest = () =>
      publish(publisher(), SHA, verdict("failure"), identity(3));
    const middle = () =>
      publish(publisher(), SHA, verdict("success"), identity(2));
    // The oldest publisher decides to write before the middle one lands,
    // then picks the middle observation to re-post; the newest failure
    // lands and settles before that re-post does.
    publish(
      publisher({ 1: middle, 2: newest }),
      SHA,
      verdict("success"),
      identity(1),
    );
    expect(latest()?.conclusion).toBe("failure");
    expect(latest()?.identity).toEqual(identity(3));
  });

  test("a newer read of the unchanged verdict is recorded, so an older different one stays stale", () => {
    const pending = verdict("pending");
    const { publisher, latest } = github([
      {
        id: 1,
        identity: identity(0),
        status: "in_progress",
        conclusion: null,
        title: pending.title,
        summary: pending.summary,
        startedAt: at(0),
      },
    ]);
    const newer = () => publish(publisher(), SHA, pending, identity(2));
    // The older success decided to write before the newer read re-stamped.
    publish(publisher({ 1: newer }), SHA, verdict("success"), identity(1));
    expect(latest()?.status).toBe("in_progress");
    expect(latest()?.identity).toEqual(identity(2));
    // One read before it and arriving after it is stale outright.
    publish(publisher(), SHA, verdict("failure"), identity(1));
    expect(latest()?.status).toBe("in_progress");
  });

  // Merge group evaluations for one commit no longer queue behind each other
  // (the relay's, the sweep's): whichever lands last, the newest read wins.
  test("merge group: an older evaluation landing last never overwrites the newer verdict", () => {
    const { publisher, latest } = github();
    const group = (minutes: number): RunIdentity => ({
      kind: "group",
      members: [1, 2],
      observedAt: at(minutes),
    });
    const newer = () =>
      publish(publisher(), GROUP_SHA, verdict("failure"), group(2));
    // The sweep read the group first, then the relay's newer read landed
    // before the sweep's write.
    publish(publisher({ 1: newer }), GROUP_SHA, verdict("success"), group(1));
    expect(latest()?.conclusion).toBe("failure");
    expect(latest()?.identity).toEqual(group(2));
    // An even older read arriving afterwards is stale outright.
    publish(publisher(), GROUP_SHA, verdict("success"), group(0));
    expect(latest()?.identity).toEqual(group(2));
  });
});
