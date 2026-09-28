import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  affectedGroups,
  confirmDequeue,
  decidePublish,
  decodeIdentity,
  encodeIdentity,
  evaluatePullRequest,
  groupMembers,
  groupOutput,
  headClockStart,
  isReviewerSignal,
  latestRun,
  parseReviewGateConfig,
  pullRequestOutput,
  selectSweepTargets,
  shouldDequeue,
  type OpenPullRequest,
  type PublishedRun,
  type PullRequestSnapshot,
  type QueueEntry,
} from "./review-gate";

const HEAD_SHA = "1f0c3a7d9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d";
const OLD_SHA = "9e5b4c2a8d6f0e1b3c5a7d9e5b4c2a8d6f0e1b3c";
const OPENED = "2026-09-28T10:00:00Z";
const minutesAfter = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const RAW_CONFIG = {
  mode: "shadow",
  reviewers: [
    {
      name: "PerPush",
      done: { commit_status: { context: "PerPush", states: ["success"] } },
      scope: "head",
      timeout_minutes: 20,
    },
    {
      name: "OnRequest",
      done: {
        review_by: "request-bot",
        reaction: { by: "request-bot", content: "THUMBS_UP" },
      },
      scope: "request",
      rerequest_comment: "@request-bot review",
      timeout_minutes: 15,
      skip_authors: ["dependabot[bot]"],
    },
  ],
  skip_authors: ["github-actions[bot]"],
  skip_paths: ["docs/**", "**/*.md"],
};
const CONFIG = parseReviewGateConfig(RAW_CONFIG);

const snapshot = (
  overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot => ({
  number: 101,
  headSha: HEAD_SHA,
  isDraft: false,
  author: "pr-author",
  readyAt: OPENED,
  files: ["apps/api/src/index.ts"],
  reviews: [],
  reactions: [],
  comments: [],
  statuses: [],
  checkRuns: [],
  threads: { complete: true, unresolved: [] },
  headClockStartedAt: OPENED,
  ...overrides,
});

// Both reviewers reported on the current request and head.
const reported: Partial<PullRequestSnapshot> = {
  statuses: [{ context: "PerPush", state: "SUCCESS" }],
  reactions: [
    {
      user: "request-bot[bot]",
      content: "THUMBS_UP",
      createdAt: minutesAfter(OPENED, 3),
    },
  ],
};

const THREAD = {
  url: "https://github.com/o/r/pull/101#discussion_r1",
  path: "apps/api/src/index.ts",
};
const unresolved = (count: number): PullRequestSnapshot["threads"] => ({
  complete: true,
  unresolved: Array.from({ length: count }, () => THREAD),
});

const rerequest = (at: string, authorAssociation = "MEMBER") => ({
  author: "pr-author",
  authorAssociation,
  isBot: false,
  createdAt: at,
  body: "@request-bot review",
});

const stateOf = (
  verdict: ReturnType<typeof evaluatePullRequest>,
  name: string,
) => verdict.reviewers.find((reviewer) => reviewer.name === name)?.state;

describe("reviewer wait", () => {
  test("waits for a reviewer that has not reported before its timeout", () => {
    const verdict = evaluatePullRequest(
      snapshot({ statuses: reported.statuses }),
      CONFIG,
      minutesAfter(OPENED, 5),
    );
    expect(verdict.conclusion).toBe("pending");
    expect(verdict.title).toBe("Waiting for OnRequest");
    expect(stateOf(verdict, "PerPush")).toBe("done");
  });

  test("a pending status is not a report", () => {
    const verdict = evaluatePullRequest(
      snapshot({ statuses: [{ context: "PerPush", state: "PENDING" }] }),
      CONFIG,
      minutesAfter(OPENED, 5),
    );
    expect(stateOf(verdict, "PerPush")).toBe("waiting");
  });

  test("a reviewer that errors keeps the gate waiting, not passing", () => {
    const verdict = evaluatePullRequest(
      snapshot({
        ...reported,
        statuses: [{ context: "PerPush", state: "ERROR" }],
      }),
      CONFIG,
      minutesAfter(OPENED, 5),
    );
    expect(verdict.conclusion).toBe("pending");
    expect(stateOf(verdict, "PerPush")).toBe("errored");
    expect(pullRequestOutput(verdict, null).summary).toContain(
      "reported error",
    );
  });

  test("an erroring reviewer is waived at its timeout, and the title says so", () => {
    const verdict = evaluatePullRequest(
      snapshot({
        ...reported,
        statuses: [{ context: "PerPush", state: "FAILURE" }],
      }),
      CONFIG,
      minutesAfter(OPENED, 20),
    );
    expect(verdict.conclusion).toBe("success");
    expect(stateOf(verdict, "PerPush")).toBe("timed-out");
    expect(verdict.title).toBe("Passed with review waived: PerPush timed out");
  });

  test("a check run counts only in a configured conclusion", () => {
    const config = parseReviewGateConfig({
      mode: "shadow",
      reviewers: [
        {
          name: "Checker",
          done: {
            check_run: { name: "checker", conclusions: ["success", "neutral"] },
          },
          scope: "head",
          timeout_minutes: 10,
        },
      ],
    });
    const run = (conclusion: string) =>
      evaluatePullRequest(
        snapshot({
          checkRuns: [{ name: "checker", status: "COMPLETED", conclusion }],
        }),
        config,
        minutesAfter(OPENED, 1),
      );
    expect(stateOf(run("NEUTRAL"), "Checker")).toBe("done");
    expect(stateOf(run("CANCELLED"), "Checker")).toBe("errored");
  });

  test("passes once the timeout elapses and names the reviewer that never reported", () => {
    const verdict = evaluatePullRequest(
      snapshot({ statuses: reported.statuses }),
      CONFIG,
      minutesAfter(OPENED, 15),
    );
    expect(verdict.conclusion).toBe("success");
    expect(stateOf(verdict, "OnRequest")).toBe("timed-out");
    expect(pullRequestOutput(verdict, null).summary).toContain(
      "OnRequest: never reported; review waived after 15 min",
    );
  });

  test("passes when every reviewer reported and no thread is open", () => {
    const verdict = evaluatePullRequest(
      snapshot(reported),
      CONFIG,
      minutesAfter(OPENED, 4),
    );
    expect(verdict.conclusion).toBe("success");
    expect(verdict.title).toBe("Reviews complete, no unresolved threads");
  });

  test("head scope: a review of an older commit does not count", () => {
    const config = parseReviewGateConfig({
      mode: "shadow",
      reviewers: [
        {
          name: "PerPushReview",
          done: { review_by: "push-bot" },
          scope: "head",
          timeout_minutes: 20,
        },
      ],
    });
    const review = { author: "push-bot", submittedAt: minutesAfter(OPENED, 2) };
    const old = evaluatePullRequest(
      snapshot({ reviews: [{ ...review, commitSha: OLD_SHA }] }),
      config,
      minutesAfter(OPENED, 5),
    );
    expect(old.conclusion).toBe("pending");
    const current = evaluatePullRequest(
      snapshot({ reviews: [{ ...review, commitSha: HEAD_SHA }] }),
      config,
      minutesAfter(OPENED, 5),
    );
    expect(current.conclusion).toBe("success");
  });

  test("head scope: the clock restarts when the gate first reports on a new head", () => {
    const pushed = minutesAfter(OPENED, 60);
    const verdict = evaluatePullRequest(
      snapshot({ ...reported, statuses: [], headClockStartedAt: pushed }),
      CONFIG,
      minutesAfter(pushed, 5),
    );
    expect(stateOf(verdict, "PerPush")).toBe("waiting");
  });

  test("request scope: a review of an older commit counts, and says it does not cover later pushes", () => {
    const verdict = evaluatePullRequest(
      snapshot({
        statuses: reported.statuses,
        reviews: [
          {
            author: "request-bot",
            submittedAt: minutesAfter(OPENED, 4),
            commitSha: OLD_SHA,
          },
        ],
      }),
      CONFIG,
      minutesAfter(OPENED, 5),
    );
    expect(stateOf(verdict, "OnRequest")).toBe("done");
    expect(pullRequestOutput(verdict, null).summary).toContain(
      "does not cover later pushes",
    );
  });

  test("a re-request restarts the wait; a report from before it does not count", () => {
    const rerequested = minutesAfter(OPENED, 30);
    const waiting = evaluatePullRequest(
      snapshot({ ...reported, comments: [rerequest(rerequested)] }),
      CONFIG,
      minutesAfter(rerequested, 5),
    );
    expect(stateOf(waiting, "OnRequest")).toBe("waiting");

    const answered = evaluatePullRequest(
      snapshot({
        ...reported,
        comments: [rerequest(rerequested)],
        reviews: [
          {
            author: "request-bot",
            submittedAt: minutesAfter(rerequested, 3),
            commitSha: HEAD_SHA,
          },
        ],
      }),
      CONFIG,
      minutesAfter(rerequested, 5),
    );
    expect(stateOf(answered, "OnRequest")).toBe("done");
  });

  test.each(["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR"])(
    "a re-request from an outsider (%s) does not restart the wait",
    (association) => {
      const verdict = evaluatePullRequest(
        snapshot({
          ...reported,
          comments: [rerequest(minutesAfter(OPENED, 30), association)],
        }),
        CONFIG,
        minutesAfter(OPENED, 31),
      );
      expect(stateOf(verdict, "OnRequest")).toBe("done");
    },
  );

  test("a bot quoting the re-request phrase does not restart the wait", () => {
    const verdict = evaluatePullRequest(
      snapshot({
        ...reported,
        comments: [
          {
            ...rerequest(minutesAfter(OPENED, 30)),
            author: "request-bot",
            isBot: true,
          },
        ],
      }),
      CONFIG,
      minutesAfter(OPENED, 31),
    );
    expect(stateOf(verdict, "OnRequest")).toBe("done");
  });

  test("the wait starts when a draft becomes ready, not while it was a draft", () => {
    const ready = minutesAfter(OPENED, 120);
    const verdict = evaluatePullRequest(
      snapshot({ statuses: reported.statuses, readyAt: ready }),
      CONFIG,
      minutesAfter(ready, 5),
    );
    expect(stateOf(verdict, "OnRequest")).toBe("waiting");
    expect(stateOf(verdict, "PerPush")).toBe("done");
  });

  test("a draft is pending whatever else holds", () => {
    const verdict = evaluatePullRequest(
      snapshot({ ...reported, isDraft: true }),
      CONFIG,
      minutesAfter(OPENED, 60),
    );
    expect(verdict.conclusion).toBe("pending");
    expect(verdict.title).toBe("Draft");
  });
});

describe("unresolved threads", () => {
  test("fail the gate even while a reviewer is still pending", () => {
    const verdict = evaluatePullRequest(
      snapshot({ threads: unresolved(1) }),
      CONFIG,
      minutesAfter(OPENED, 1),
    );
    expect(verdict.conclusion).toBe("failure");
    expect(verdict.title).toBe("1 unresolved review thread");
    expect(pullRequestOutput(verdict, null).summary).toContain(THREAD.url);
  });

  test("are never waived by a reviewer timeout", () => {
    const verdict = evaluatePullRequest(
      snapshot({ threads: unresolved(2) }),
      CONFIG,
      minutesAfter(OPENED, 600),
    );
    expect(verdict.conclusion).toBe("failure");
    expect(verdict.title).toBe("2 unresolved review threads");
  });

  test("a thread list the gate could not finish reading fails, never reads as zero", () => {
    const verdict = evaluatePullRequest(
      snapshot({ ...reported, threads: { complete: false } }),
      CONFIG,
      minutesAfter(OPENED, 5),
    );
    expect(verdict.conclusion).toBe("failure");
    expect(verdict.title).toBe("Review threads could not all be read");
  });
});

describe("skip rules", () => {
  test("an author skip waives the reviewer wait", () => {
    const verdict = evaluatePullRequest(
      snapshot({ author: "github-actions" }),
      CONFIG,
      minutesAfter(OPENED, 1),
    );
    expect(verdict.conclusion).toBe("success");
    expect(verdict.reviewers).toEqual([]);
    expect(pullRequestOutput(verdict, null).summary).toContain(
      "Reviewer wait skipped: author github-actions",
    );
  });

  test("a diff of only skipped paths waives the reviewer wait", () => {
    const verdict = evaluatePullRequest(
      snapshot({ files: ["docs/guide.md", "README.md"] }),
      CONFIG,
      minutesAfter(OPENED, 1),
    );
    expect(verdict.conclusion).toBe("success");
  });

  test("a skipped pull request still fails on an unresolved thread", () => {
    const verdict = evaluatePullRequest(
      snapshot({ author: "github-actions", threads: unresolved(1) }),
      CONFIG,
      minutesAfter(OPENED, 1),
    );
    expect(verdict.conclusion).toBe("failure");
  });

  test.each([
    [
      "a partial path match",
      { files: ["docs/guide.md", "apps/api/src/index.ts"] },
    ],
    ["an unknown file list", { files: null }],
  ])("%s does not skip", (_, overrides) => {
    const verdict = evaluatePullRequest(
      snapshot(overrides),
      CONFIG,
      minutesAfter(OPENED, 1),
    );
    expect(verdict.conclusion).toBe("pending");
  });

  test("the config offers no title or label skip a pull request could grant itself", () => {
    expect(() =>
      parseReviewGateConfig({
        ...RAW_CONFIG,
        skip: { title_prefixes: ["chore: release v"] },
      }),
    ).toThrow("unknown key(s) skip");
  });

  test("a per-reviewer skip waives only that reviewer", () => {
    const verdict = evaluatePullRequest(
      snapshot({ author: "dependabot", statuses: reported.statuses }),
      CONFIG,
      minutesAfter(OPENED, 1),
    );
    expect(stateOf(verdict, "OnRequest")).toBe("skipped");
    expect(stateOf(verdict, "PerPush")).toBe("done");
    expect(verdict.conclusion).toBe("success");
  });
});

describe("workflow edits", () => {
  test("a pull request that edits workflows or the gate is flagged for a human", () => {
    const files = [
      ".github/workflows/review-gate.yml",
      "apps/api/src/index.ts",
    ];
    const verdict = evaluatePullRequest(
      snapshot({ ...reported, files }),
      CONFIG,
      minutesAfter(OPENED, 5),
    );
    expect(pullRequestOutput(verdict, files).summary).toContain(
      "judged by the base branch's version; workflow edits need a human review",
    );
  });

  test("an ordinary pull request carries no such note", () => {
    const verdict = evaluatePullRequest(snapshot(reported), CONFIG, OPENED);
    expect(
      pullRequestOutput(verdict, ["apps/api/src/index.ts"]).summary,
    ).not.toContain("workflow edits");
  });
});

describe("merge group", () => {
  const entries: readonly QueueEntry[] = [
    { position: 1, headSha: "a".repeat(40), pullRequest: 201 },
    { position: 2, headSha: "b".repeat(40), pullRequest: 202 },
    { position: 3, headSha: "c".repeat(40), pullRequest: 203 },
    { position: 4, headSha: null, pullRequest: 204 },
  ];

  test("a group commit merges its entry and every entry ahead of it", () => {
    expect(groupMembers(entries, "c".repeat(40))).toEqual([201, 202, 203]);
    expect(groupMembers(entries, "a".repeat(40))).toEqual([201]);
  });

  test("membership is unknown when the queue does not list the commit", () => {
    expect(groupMembers(entries, "d".repeat(40))).toBeNull();
  });

  test("membership is unknown when the prefix has a gap (a rebuild in flight)", () => {
    const gapped = entries.filter(({ position }) => position !== 2);
    expect(groupMembers(gapped, "c".repeat(40))).toBeNull();
  });

  test("a change to a queued pull request reaches its group and every built group behind it", () => {
    expect(affectedGroups(entries, 202)).toEqual([
      "b".repeat(40),
      "c".repeat(40),
    ]);
    expect(affectedGroups(entries, 204)).toEqual([]);
    expect(affectedGroups(entries, 999)).toEqual([]);
  });

  test("with two pull requests, a late thread on one fails the group and names it", () => {
    const now = minutesAfter(OPENED, 30);
    const clean = evaluatePullRequest(
      snapshot({ ...reported, number: 201 }),
      CONFIG,
      now,
    );
    const late = evaluatePullRequest(
      snapshot({ ...reported, number: 202, threads: unresolved(1) }),
      CONFIG,
      now,
    );
    const output = groupOutput([clean, late]);
    expect(output.conclusion).toBe("failure");
    expect(output.title).toBe("#202: 1 unresolved review thread");
    expect(output.summary).toContain("### #201");
    expect(output.summary).toContain("### #202");
    expect(groupOutput([clean, clean]).conclusion).toBe("success");
  });

  test("one pending pull request holds the whole group", () => {
    const now = minutesAfter(OPENED, 5);
    const clean = evaluatePullRequest(
      snapshot({ ...reported, number: 201 }),
      CONFIG,
      now,
    );
    const waiting = evaluatePullRequest(
      snapshot({ statuses: reported.statuses, number: 202 }),
      CONFIG,
      now,
    );
    expect(groupOutput([clean, waiting]).conclusion).toBe("pending");
  });
});

describe("dequeue", () => {
  const failing = evaluatePullRequest(
    snapshot({ threads: unresolved(1) }),
    CONFIG,
    OPENED,
  );
  const passing = evaluatePullRequest(snapshot(reported), CONFIG, OPENED);

  test("never in shadow mode", () => {
    expect(shouldDequeue("shadow", failing, true)).toBe(false);
  });

  test("in enforce mode, only a queued pull request that now fails", () => {
    expect(shouldDequeue("enforce", failing, true)).toBe(true);
    expect(shouldDequeue("enforce", failing, false)).toBe(false);
    expect(shouldDequeue("enforce", passing, true)).toBe(false);
  });

  const fresh = { queued: true, headSha: HEAD_SHA, threads: unresolved(1) };

  test("a fresh read that still shows the offence confirms it", () => {
    expect(confirmDequeue(failing, fresh)).toBe(true);
    expect(
      confirmDequeue(failing, { ...fresh, threads: { complete: false } }),
    ).toBe(true);
  });

  test.each([
    ["it already left the queue", { queued: false }],
    ["its head moved", { headSha: OLD_SHA }],
    ["its threads were resolved", { threads: unresolved(0) }],
  ])("no dequeue when, since the verdict, %s", (_, change) => {
    expect(confirmDequeue(failing, { ...fresh, ...change })).toBe(false);
  });

  test("a verdict that is not a failure never confirms", () => {
    expect(confirmDequeue(passing, fresh)).toBe(false);
  });
});

describe("publishing", () => {
  const output = pullRequestOutput(
    evaluatePullRequest(snapshot(reported), CONFIG, minutesAfter(OPENED, 5)),
    null,
  );
  const failing = pullRequestOutput(
    evaluatePullRequest(snapshot({ threads: unresolved(1) }), CONFIG, OPENED),
    null,
  );
  const published = (
    observedAt: string,
    overrides: Partial<PublishedRun> = {},
  ): PublishedRun => ({
    identity: { kind: "pr", pullRequest: 101, observedAt },
    status: "completed",
    conclusion: "success",
    title: output.title,
    summary: output.summary,
    startedAt: observedAt,
    ...overrides,
  });

  test("identities round-trip", () => {
    const identities = [
      { kind: "pr", pullRequest: 101, observedAt: OPENED },
      { kind: "group", members: [201, 202], observedAt: OPENED },
      { kind: "group", members: [], observedAt: OPENED },
    ] as const;
    for (const identity of identities) {
      expect(decodeIdentity(encodeIdentity(identity))).toEqual(identity);
    }
    expect(decodeIdentity("something else")).toBeNull();
    expect(decodeIdentity(null)).toBeNull();
  });

  test("a first verdict is written; the same verdict is not written twice", () => {
    expect(decidePublish(undefined, output, OPENED)).toBe("write");
    expect(
      decidePublish(published(OPENED), output, minutesAfter(OPENED, 1)),
    ).toBe("unchanged");
  });

  test("out of order: a success read before a published failure never overwrites it", () => {
    const failure = published(minutesAfter(OPENED, 2), {
      conclusion: "failure",
      title: failing.title,
      summary: failing.summary,
    });
    expect(decidePublish(failure, output, minutesAfter(OPENED, 1))).toBe(
      "stale",
    );
  });

  test("out of order: a failure read before a published success does not overwrite it either", () => {
    expect(
      decidePublish(
        published(minutesAfter(OPENED, 2)),
        failing,
        minutesAfter(OPENED, 1),
      ),
    ).toBe("stale");
  });

  test("a newer read replaces an older verdict", () => {
    expect(
      decidePublish(published(OPENED), failing, minutesAfter(OPENED, 1)),
    ).toBe("write");
  });

  test("a run without this gate's identity is overwritten, whatever it says", () => {
    expect(
      decidePublish(
        published(minutesAfter(OPENED, 60), { identity: null, title: "other" }),
        output,
        OPENED,
      ),
    ).toBe("write");
  });

  test("the latest run is the one started last", () => {
    const early = published(OPENED, { title: "early" });
    const late = published(minutesAfter(OPENED, 1), { title: "late" });
    expect(latestRun([late, early])?.title).toBe("late");
    expect(latestRun([])).toBeUndefined();
  });

  test("the head clock counts only this pull request's runs", () => {
    const runs: PublishedRun[] = [
      published(OPENED, {
        identity: { kind: "pr", pullRequest: 999, observedAt: OPENED },
      }),
      published(minutesAfter(OPENED, 5)),
      published(minutesAfter(OPENED, 9)),
      published(minutesAfter(OPENED, 1), {
        identity: { kind: "group", members: [101], observedAt: OPENED },
      }),
    ];
    expect(headClockStart(runs, 101)).toBe(minutesAfter(OPENED, 5));
    expect(headClockStart(runs, 555)).toBeNull();
  });
});

describe("sweep", () => {
  const open = (
    number: number,
    overrides: Partial<OpenPullRequest> = {},
  ): OpenPullRequest => ({
    number,
    isDraft: false,
    queued: false,
    armed: false,
    gate: "success",
    ...overrides,
  });

  test("queued and armed pull requests are always re-evaluated, whatever their verdict", () => {
    const targets = selectSweepTargets(
      [
        open(1, { queued: true }),
        open(2, { armed: true }),
        open(3),
        open(4, { isDraft: true, gate: null }),
      ],
      10,
      0,
    );
    expect(targets).toEqual([1, 2]);
  });

  test("pending, failed and missing gates are re-evaluated; settled successes are not", () => {
    const targets = selectSweepTargets(
      [
        open(1),
        open(2, { gate: "failure" }),
        open(3, { gate: "pending" }),
        open(4, { gate: null }),
      ],
      10,
      0,
    );
    expect(targets).toEqual([2, 3, 4]);
  });

  test("past the budget, the rest rotates so none starves", () => {
    const pullRequests = [
      open(1, { queued: true }),
      ...[10, 11, 12, 13, 14].map((number) =>
        open(number, { gate: "pending" }),
      ),
    ];
    const seen = new Set<number>();
    for (let rotation = 0; rotation < 3; rotation += 1) {
      const targets = selectSweepTargets(pullRequests, 3, rotation);
      expect(targets[0]).toBe(1);
      expect(targets).toHaveLength(3);
      for (const number of targets) {
        seen.add(number);
      }
    }
    expect([...seen].toSorted((a, b) => a - b)).toEqual([
      1, 10, 11, 12, 13, 14,
    ]);
  });
});

describe("event filter", () => {
  test("only a configured status or check run name is a reviewer signal", () => {
    expect(isReviewerSignal(CONFIG, "PerPush")).toBe(true);
    expect(isReviewerSignal(CONFIG, "ci-result")).toBe(false);
    expect(isReviewerSignal(CONFIG, "review-gate")).toBe(false);
  });
});

describe("config", () => {
  test("the checked-in config parses and is in shadow mode", () => {
    const file = path.join(
      import.meta.dirname,
      "..",
      ".github",
      "review-gate.yml",
    );
    const config = parseReviewGateConfig(
      Bun.YAML.parse(readFileSync(file, "utf-8")),
    );
    expect(config.reviewers.length).toBeGreaterThan(0);
    expect(config.mode).toBe("shadow");
  });

  const reviewer = (overrides: Record<string, unknown>) => ({
    name: "x",
    scope: "head",
    timeout_minutes: 5,
    done: { check_run: { name: "x", conclusions: ["success"] } },
    ...overrides,
  });
  const withReviewers = (...reviewers: unknown[]) => ({
    mode: "shadow",
    reviewers,
  });

  test.each([
    [
      "an unknown key",
      { ...withReviewers(), extra: true },
      "unknown key(s) extra",
    ],
    ["a missing mode", { reviewers: [] }, "`mode` must be shadow or enforce"],
    [
      "a reviewer without a signal",
      withReviewers(reviewer({ done: {} })),
      "needs at least one signal",
    ],
    [
      "a status without success states",
      withReviewers(reviewer({ done: { commit_status: { context: "x" } } })),
      "`commit_status.states` lists no state",
    ],
    [
      "an unknown scope",
      withReviewers(reviewer({ scope: "always" })),
      "`scope` must be head or request",
    ],
    [
      "a non-positive timeout",
      withReviewers(reviewer({ timeout_minutes: 0 })),
      "`timeout_minutes` must be a positive integer",
    ],
    [
      "a reaction without its login",
      withReviewers(reviewer({ done: { reaction: { content: "THUMBS_UP" } } })),
      "`by` must be a non-empty string",
    ],
    [
      "duplicate names",
      withReviewers(reviewer({}), reviewer({})),
      "reviewer names must be unique",
    ],
  ])("rejects %s", (_, raw, message) => {
    expect(() => parseReviewGateConfig(raw)).toThrow(message);
  });
});
