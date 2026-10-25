import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { drawPropertySamples } from "@stll/property-testing";

import {
  assertReleaseQueueHistory,
  formatReleaseQueueHistoryNotice,
  parseOptions,
  previousReleaseTag,
  releaseCommitHistoryQuery,
  ReleaseQueueHistoryError,
  releaseQueueHistoryWarning,
  runReleaseQueueHistoryCli,
} from "./check-release-queue-history";

const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIRST_SHA = "1111111111111111111111111111111111111111";
const SECOND_SHA = "2222222222222222222222222222222222222222";
const THIRD_SHA = "3333333333333333333333333333333333333333";
const FOURTH_SHA = "4444444444444444444444444444444444444444";

// GitHub reports an unmerged pull request with no merge commit or date.
type FakePullRequest = {
  html_url: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
  number: number;
  title: string;
};

const pullRequest = (number: number, sha: string): FakePullRequest => ({
  html_url: `https://github.com/stella/stella/pull/${String(number)}`,
  merge_commit_sha: sha,
  merged_at: "2026-10-01T00:00:00Z",
  number,
  title: `Change ${String(number)}`,
});

const QUEUED = ["AddedToMergeQueueEvent", "MergedEvent"] as const;
const DIRECT = ["MergedEvent"] as const;
const REMOVED = [
  "AddedToMergeQueueEvent",
  "RemovedFromMergeQueueEvent",
  "MergedEvent",
] as const;

const timelineItems = (events: readonly string[], hasPreviousPage = false) => ({
  nodes: events.map((__typename) => ({ __typename })),
  pageInfo: { hasPreviousPage },
});

const mergeGroupSuite = (
  overrides: { conclusion?: string; event?: string; path?: string } = {},
) => ({
  conclusion: overrides.conclusion ?? "SUCCESS",
  workflowRun: {
    event: overrides.event ?? "merge_group",
    file: { path: overrides.path ?? ".github/workflows/ci.yml" },
  },
});

const MAIN_TIP_SHA = "9999999999999999999999999999999999999999";

const heavyRun = (sha: string, headSha: string, event: string) => ({
  conclusion: "success",
  display_title: `Main heavy suites ${sha}`,
  event,
  head_sha: headSha,
});

type FakeOptions = {
  commits?: readonly string[];
  direct?: readonly number[];
  heavyEvent?: string;
  heavyHeadSha?: string;
  heavySha?: string | null;
  missingPullRequestFor?: readonly string[];
  pullRequestsFor?: (sha: string, index: number) => FakePullRequest[];
  eventsFor?: (number: number) => readonly string[];
  removed?: readonly number[];
  truncated?: readonly number[];
  dispatchPages?: readonly (readonly object[])[];
  fourCommits?: boolean;
  successfulMergeGroupShas?: readonly string[];
  // Check suite pages per commit; the batched query carries the first page.
  checkSuitePages?: Readonly<Record<string, readonly (readonly object[])[]>>;
  // Rewrites one commit's node in the batched answer, to corrupt it.
  rewriteCommit?: (sha: string, node: Record<string, unknown>) => unknown;
  // Rewrites the whole batched answer.
  rewriteHistory?: (payload: Record<string, unknown>) => unknown;
};

const HEAVY_COMMIT_ENDPOINT =
  /^actions\/workflows\/main-heavy\.yml\/runs\?head_sha=(\w+)&event=(push|schedule)&status=success&per_page=1&page=1$/u;
const HEAVY_DISPATCH_ENDPOINT =
  /^actions\/workflows\/main-heavy\.yml\/runs\?event=workflow_dispatch&status=success&per_page=100&page=(\d+)$/u;
const HISTORY_ALIAS = /c(\d+): object\(oid: "([0-9a-f]{40})"\)/gu;

const fillerRuns = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    heavyRun(String(index).padEnd(40, "f"), MAIN_TIP_SHA, "workflow_dispatch"),
  );

const DEFAULT_NUMBERS: Readonly<Record<string, number>> = {
  [FIRST_SHA]: 101,
  [SECOND_SHA]: 202,
  [THIRD_SHA]: 303,
  [FOURTH_SHA]: 404,
};

const fakeCommand = ({
  commits,
  direct = [],
  heavyEvent = "workflow_dispatch",
  heavyHeadSha = MAIN_TIP_SHA,
  heavySha = null,
  missingPullRequestFor = [],
  pullRequestsFor,
  eventsFor,
  removed = [],
  dispatchPages,
  fourCommits = false,
  successfulMergeGroupShas = [THIRD_SHA],
  checkSuitePages = {},
  rewriteCommit = (_sha, node) => node,
  rewriteHistory = (payload) => payload,
  truncated = [],
}: FakeOptions = {}) => {
  const historyRequests: string[][] = [];
  const checkSuiteRequests: string[] = [];
  const dispatchRequests: string[] = [];
  const heavyRequests: string[] = [];
  const history = commits ?? [
    FIRST_SHA,
    SECOND_SHA,
    THIRD_SHA,
    ...(fourCommits ? [FOURTH_SHA] : []),
  ];
  const pullRequestsOf = (sha: string): FakePullRequest[] => {
    if (missingPullRequestFor.includes(sha)) {
      return [];
    }
    if (pullRequestsFor) {
      return pullRequestsFor(sha, history.indexOf(sha));
    }
    const number = DEFAULT_NUMBERS[sha];
    return number === undefined ? [] : [pullRequest(number, sha)];
  };
  const eventsOf = (number: number): readonly string[] => {
    if (eventsFor) {
      return eventsFor(number);
    }
    if (direct.includes(number)) {
      return DIRECT;
    }
    return removed.includes(number) ? REMOVED : QUEUED;
  };
  const suitePagesOf = (sha: string): readonly (readonly object[])[] =>
    checkSuitePages[sha] ?? [
      successfulMergeGroupShas.includes(sha) ? [mergeGroupSuite()] : [],
    ];
  const suitePage = (sha: string, page: number) => {
    const pages = suitePagesOf(sha);
    const hasNextPage = page < pages.length - 1;
    return {
      nodes: pages[page] ?? [],
      pageInfo: {
        endCursor: hasNextPage ? `page${String(page + 1)}` : null,
        hasNextPage,
      },
    };
  };
  const commitNode = (sha: string): Record<string, unknown> => ({
    associatedPullRequests: {
      nodes: pullRequestsOf(sha).map((entry) => ({
        mergeCommit:
          entry.merge_commit_sha === null
            ? null
            : { oid: entry.merge_commit_sha },
        mergedAt: entry.merged_at,
        number: entry.number,
        timelineItems: timelineItems(
          eventsOf(entry.number),
          truncated.includes(entry.number),
        ),
        title: entry.title,
        url: entry.html_url,
      })),
      pageInfo: { hasNextPage: false },
    },
    checkSuites: suitePage(sha, 0),
    oid: sha,
  });
  const argument = (command: readonly string[], name: string) =>
    command
      .find((entry) => entry.startsWith(`${name}=`))
      ?.slice(name.length + 1);

  const run = (command: readonly string[]): string => {
    if (command.at(0) === "git" && command.at(1) === "rev-parse") {
      return BASE_SHA;
    }
    if (command.at(0) === "git" && command.at(1) === "rev-list") {
      return history.join("\n");
    }
    if (command.at(0) === "git" && command.at(1) === "show") {
      const sha = command.at(-1) ?? "";
      return sha === SECOND_SHA
        ? "2222222 Direct release adjustment"
        : `${sha.slice(0, 7)} Direct change`;
    }
    const query = argument(command, "query");
    if (
      command.at(3) === "graphql" &&
      query?.includes("ReleaseCommitHistory")
    ) {
      const repository: Record<string, unknown> = {};
      const shas: string[] = [];
      for (const [, index, sha] of query.matchAll(HISTORY_ALIAS)) {
        if (index !== undefined && sha !== undefined) {
          shas.push(sha);
          repository[`c${index}`] = rewriteCommit(sha, commitNode(sha));
        }
      }
      historyRequests.push(shas);
      return JSON.stringify(rewriteHistory({ data: { repository } }));
    }
    if (
      command.at(3) === "graphql" &&
      query?.includes("ReleaseCommitCheckSuites")
    ) {
      const sha = argument(command, "oid") ?? "";
      const after = argument(command, "after") ?? "";
      checkSuiteRequests.push(`${sha}@${after}`);
      return JSON.stringify({
        data: {
          repository: {
            object: {
              checkSuites: suitePage(sha, Number(after.slice("page".length))),
            },
          },
        },
      });
    }
    const endpoint = command.at(-1)?.replace("repos/stella/stella/", "");
    const heavyRuns =
      heavySha === null ? [] : [heavyRun(heavySha, heavyHeadSha, heavyEvent)];
    const heavyCommit = endpoint ? HEAVY_COMMIT_ENDPOINT.exec(endpoint) : null;
    if (endpoint && heavyCommit) {
      heavyRequests.push(endpoint);
      return JSON.stringify({
        workflow_runs: heavyRuns.filter(
          (entry) =>
            entry.head_sha === heavyCommit[1] && entry.event === heavyCommit[2],
        ),
      });
    }
    const heavyDispatch = endpoint
      ? HEAVY_DISPATCH_ENDPOINT.exec(endpoint)
      : null;
    if (endpoint && heavyDispatch) {
      dispatchRequests.push(endpoint);
      return JSON.stringify({
        workflow_runs:
          dispatchPages?.[Number(heavyDispatch[1]) - 1] ??
          heavyRuns.filter((entry) => entry.event === "workflow_dispatch"),
      });
    }
    throw new Error(`Unexpected command: ${command.join(" ")}`);
  };
  return Object.assign(run, {
    checkSuiteRequests,
    dispatchRequests,
    heavyRequests,
    historyRequests,
  });
};

const check = (command: (command: readonly string[]) => string) =>
  assertReleaseQueueHistory({
    baseSha: BASE_SHA,
    command,
    ghRetryScript: "/fake/gh-retry.sh",
    previousTag: "v1.2.3",
  });

describe("release queue history", () => {
  test("allows a merge queue batch when only its tip has a merge-group run", () => {
    expect(() => check(fakeCommand())).not.toThrow();
  });

  test("reads the whole history in one query, with no per-commit or per-pull-request read", () => {
    const command = fakeCommand();

    expect(check(command).validated).toBeTrue();
    expect(command.historyRequests).toEqual([
      [FIRST_SHA, SECOND_SHA, THIRD_SHA],
    ]);
    expect(command.checkSuiteRequests).toEqual([]);
  });

  test("covers a batch by a run three commits ahead", () => {
    const command = fakeCommand({
      fourCommits: true,
      successfulMergeGroupShas: [FOURTH_SHA],
    });

    expect(check(command).validated).toBeTrue();
  });

  test("does not cover a batch by a run four commits ahead", () => {
    const fifthSha = "5555555555555555555555555555555555555555";
    const report = check(
      fakeCommand({
        commits: [FIRST_SHA, SECOND_SHA, THIRD_SHA, FOURTH_SHA, fifthSha],
        pullRequestsFor: (sha, index) => [pullRequest(100 + index, sha)],
        successfulMergeGroupShas: [fifthSha],
      }),
    );

    expect(report.bypassingPullRequests.map(({ number }) => number)).toEqual([
      100,
    ]);
  });

  test("splits a long history into queries of twenty-five commits", () => {
    const commits = Array.from({ length: 120 }, (_, index) =>
      (index + 1).toString(16).padStart(40, "a"),
    );
    const command = fakeCommand({
      commits,
      pullRequestsFor: (sha, index) => [pullRequest(1000 + index, sha)],
      successfulMergeGroupShas: commits,
    });

    expect(check(command).validated).toBeTrue();
    expect(command.historyRequests.map((batch) => batch.length)).toEqual([
      25, 25, 25, 25, 20,
    ]);
    expect(command.historyRequests.flat()).toEqual(commits);
  });

  test("pages through check suites until the merge-group run appears", () => {
    const filler = Array.from({ length: 3 }, () =>
      mergeGroupSuite({ event: "push" }),
    );
    const command = fakeCommand({
      checkSuitePages: {
        [THIRD_SHA]: [
          filler,
          [mergeGroupSuite({ path: ".github/workflows/cla.yml" })],
          [mergeGroupSuite()],
        ],
      },
    });

    expect(check(command).validated).toBeTrue();
    expect(command.checkSuiteRequests).toEqual([
      `${THIRD_SHA}@page1`,
      `${THIRD_SHA}@page2`,
    ]);
  });

  test("counts only a successful ci.yml merge_group suite as a merge-group run", () => {
    for (const suite of [
      mergeGroupSuite({ conclusion: "FAILURE" }),
      mergeGroupSuite({ event: "push" }),
      mergeGroupSuite({ path: ".github/workflows/cla.yml" }),
      { conclusion: "SUCCESS", workflowRun: null },
    ]) {
      const report = check(
        fakeCommand({ checkSuitePages: { [THIRD_SHA]: [[suite]] } }),
      );
      expect(report.validated, JSON.stringify(suite)).toBeFalse();
    }
  });

  test("fails closed when the check suites run past the page limit", () => {
    const command = fakeCommand({
      checkSuitePages: { [THIRD_SHA]: Array.from({ length: 21 }, () => []) },
    });

    expect(() => check(command)).toThrow(
      `Check suites for ${THIRD_SHA} exceed 20 pages of 50`,
    );
  });

  test("fails closed on a missing, cut or malformed commit in the batched answer", () => {
    const cases: [string, FakeOptions][] = [
      ["unknown commit", { rewriteCommit: () => null }],
      [
        "another commit's node",
        { rewriteCommit: (_sha, node) => ({ ...node, oid: BASE_SHA }) },
      ],
      [
        "more associated pull requests than one page",
        {
          rewriteCommit: (_sha, node) => ({
            ...node,
            associatedPullRequests: {
              nodes: [],
              pageInfo: { hasNextPage: true },
            },
          }),
        },
      ],
      [
        "pull request without a number",
        {
          rewriteCommit: (_sha, node) => ({
            ...node,
            associatedPullRequests: {
              nodes: [
                { title: "x", url: "u", mergedAt: null, mergeCommit: null },
              ],
              pageInfo: { hasNextPage: false },
            },
          }),
        },
      ],
    ];
    for (const [label, options] of cases) {
      expect(() => check(fakeCommand(options)), label).toThrow(
        `Pull requests for ${FIRST_SHA} returned an unexpected payload`,
      );
    }
  });

  test("fails closed on malformed check suites", () => {
    expect(() =>
      check(
        fakeCommand({
          rewriteCommit: (sha, node) =>
            sha === THIRD_SHA ? { ...node, checkSuites: { nodes: [] } } : node,
        }),
      ),
    ).toThrow(`Check suites for ${THIRD_SHA} returned an unexpected payload`);
    expect(() =>
      check(
        fakeCommand({
          checkSuitePages: {
            [THIRD_SHA]: [[{ conclusion: "SUCCESS", workflowRun: {} }]],
          },
        }),
      ),
    ).toThrow(`Check suites for ${THIRD_SHA} returned an unexpected payload`);
  });

  test("fails closed on a GraphQL answer that carries errors or no data", () => {
    for (const rewriteHistory of [
      (payload: Record<string, unknown>) => ({
        ...payload,
        errors: [{ message: "timeout" }],
      }),
      () => ({ errors: [{ message: "timeout" }] }),
      () => [],
    ]) {
      expect(() => check(fakeCommand({ rewriteHistory }))).toThrow(
        "returned an unexpected payload",
      );
    }
  });

  test("never inlines anything but a full SHA into the query", () => {
    expect(() => releaseCommitHistoryQuery([`${FIRST_SHA}") { x }`])).toThrow(
      ReleaseQueueHistoryError,
    );
    expect(() => releaseCommitHistoryQuery([BASE_SHA.toUpperCase()])).toThrow(
      ReleaseQueueHistoryError,
    );
  });

  test("CLI warns when the dispatch listing exceeds the page limit", () => {
    const command = fakeCommand({
      dispatchPages: Array.from({ length: 25 }, () => fillerRuns(100)),
    });
    const warnings: string[] = [];

    const exitCode = runReleaseQueueHistoryCli(
      ["--from", "v1.2.3", "--base", BASE_SHA],
      (message) => {
        warnings.push(message);
        return true;
      },
      () => check(command),
    );

    expect(exitCode).toBe(0);
    expect(warnings).toEqual([
      "::warning::Release queue history could not be checked: Successful main-heavy.yml dispatch runs exceed 20 pages of 100",
    ]);
    expect(command.dispatchRequests).toHaveLength(20);
  });

  test("accepts a green heavy base without inspecting queue history", () => {
    const command = fakeCommand({ heavySha: BASE_SHA, truncated: [101] });

    expect(() => check(command)).not.toThrow();
    expect(command.heavyRequests).toHaveLength(2);
    expect(command.dispatchRequests).toHaveLength(1);
    expect(command.historyRequests).toHaveLength(0);
  });

  test("accepts a push run of main heavy whose head is the base", () => {
    const command = fakeCommand({
      heavyEvent: "push",
      heavyHeadSha: BASE_SHA,
      heavySha: MAIN_TIP_SHA,
      truncated: [101],
    });

    expect(() => check(command)).not.toThrow();
    expect(command.historyRequests).toHaveLength(0);
  });

  test("refuses a dispatched heavy run on the base that tested another commit", () => {
    const command = fakeCommand({
      heavyHeadSha: BASE_SHA,
      heavySha: MAIN_TIP_SHA,
      truncated: [101],
    });

    expect(() => check(command)).toThrow(ReleaseQueueHistoryError);
    expect(command.historyRequests.length).toBeGreaterThan(0);
  });

  test("fails closed on a truncated timeline without a green heavy base", () => {
    const run = () => check(fakeCommand({ truncated: [101] }));

    expect(run).toThrow(ReleaseQueueHistoryError);
    expect(run).toThrow(
      "Timeline for pull request #101 returned an unexpected payload",
    );
  });

  test("reports queued merges with no successful merge-group run", () => {
    const report = check(fakeCommand({ successfulMergeGroupShas: [] }));

    expect(report.validated).toBeFalse();
    expect(report.bypassingPullRequests.map(({ number }) => number)).toEqual([
      101, 202, 303,
    ]);
  });

  test("does not carry merge-group validation across a direct push", () => {
    const report = check(fakeCommand({ missingPullRequestFor: [SECOND_SHA] }));

    expect(report.validated).toBeFalse();
    expect(report.bypassingPullRequests.map(({ number }) => number)).toEqual([
      101,
    ]);
    expect(report.commitsWithoutPullRequest).toEqual([
      "2222222 Direct release adjustment",
    ]);
  });

  test("reports a pull request removed from the queue before a direct merge", () => {
    const report = check(fakeCommand({ removed: [202] }));

    expect(report.validated).toBeFalse();
    expect(report.bypassingPullRequests.map(({ number }) => number)).toEqual([
      101, 202,
    ]);
    expect(formatReleaseQueueHistoryNotice(report)).toContain(
      "gh workflow run main-heavy.yml --ref main -f sha=<release-sha> -f release_candidate=true",
    );
  });

  test("reports an administrator merge with no queue events", () => {
    const report = check(fakeCommand({ direct: [303] }));

    expect(report.validated).toBeFalse();
    expect(report.bypassingPullRequests.map(({ number }) => number)).toEqual([
      101, 202, 303,
    ]);
  });

  test("allows a direct merge after the base passed main heavy", () => {
    expect(() =>
      check(fakeCommand({ direct: [202], heavySha: BASE_SHA })),
    ).not.toThrow();
  });

  test("reports a commit without an associated merged pull request", () => {
    const report = check(fakeCommand({ missingPullRequestFor: [SECOND_SHA] }));

    expect(report.validated).toBeFalse();
    expect(report.commitsWithoutPullRequest).toEqual([
      "2222222 Direct release adjustment",
    ]);
  });

  test("allows a commit without a pull request after the base passed main heavy", () => {
    expect(() =>
      check(
        fakeCommand({
          heavySha: BASE_SHA,
          missingPullRequestFor: [SECOND_SHA],
        }),
      ),
    ).not.toThrow();
  });

  test("reports when main heavy succeeded only on an older commit", () => {
    const olderSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const report = check(fakeCommand({ direct: [202], heavySha: olderSha }));
    expect(report.validated).toBeFalse();
    expect(report.bypassingPullRequests.map(({ number }) => number)).toEqual([
      101, 202,
    ]);
  });

  test("CLI exits successfully and warns for unvalidated history", () => {
    const warnings: string[] = [];
    const exitCode = runReleaseQueueHistoryCli(
      ["--from", "v1.2.3", "--base", BASE_SHA],
      (message) => {
        warnings.push(message);
        return true;
      },
      () => check(fakeCommand({ direct: [303] })),
    );

    expect(exitCode).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings.at(0)).toContain("::warning::Release history");
    expect(warnings.at(0)).toContain("#303 Change 303");
  });

  test("an unreadable history is a warning, not a failure, for every caller", () => {
    const warning = releaseQueueHistoryWarning(
      () => ({ baseSha: BASE_SHA, previousTag: "v1.2.3" }),
      () => {
        throw new ReleaseQueueHistoryError(
          "Dispatch run listing exceeded 20 pages",
        );
      },
    );

    expect(warning).toBe(
      "Release queue history could not be checked: Dispatch run listing exceeded 20 pages",
    );
  });

  test("validated history produces no warning", () => {
    expect(
      releaseQueueHistoryWarning(
        () => ({ baseSha: BASE_SHA, previousTag: "v1.2.3" }),
        () => ({
          validated: true,
          bypassingPullRequests: [],
          commitsWithoutPullRequest: [],
        }),
      ),
    ).toBeNull();
  });
});

// The verdict the per-commit and per-pull-request reads gave, stated over a
// history model: a merged pull request is covered when it was in the merge
// queue at its merge and a successful merge-group run sits on its commit or
// on one of the next three, with only queued merges in between.
type ModelCommit =
  | { kind: "direct"; mergeGroup: boolean }
  | {
      kind: "pullRequest";
      timeline: "queued" | "direct" | "removed" | "requeued";
      // Another pull request GitHub associates with the commit, merged
      // elsewhere: it never counts for this commit.
      foreign: boolean;
      mergeGroup: boolean;
    };

const MODEL_TIMELINES = {
  direct: DIRECT,
  queued: QUEUED,
  removed: REMOVED,
  requeued: [
    "AddedToMergeQueueEvent",
    "RemovedFromMergeQueueEvent",
    "AddedToMergeQueueEvent",
    "MergedEvent",
  ],
} as const;

const modelSha = (index: number) => (index + 1).toString(16).padStart(40, "c");
const modelNumber = (index: number) => 1000 + index;
const FOREIGN_OFFSET = 50_000;

const specifiedReport = (commits: readonly ModelCommit[]) => {
  const queued = (index: number) => {
    const commit = commits[index];
    return (
      commit?.kind === "pullRequest" &&
      (commit.timeline === "queued" || commit.timeline === "requeued")
    );
  };
  const covered = (index: number) =>
    [0, 1, 2, 3].some(
      (ahead) =>
        index + ahead < commits.length &&
        Array.from({ length: ahead + 1 }, (_, step) => index + step).every(
          queued,
        ) &&
        commits[index + ahead]?.mergeGroup === true,
    );
  const bypassing = commits.flatMap((commit, index) =>
    commit.kind === "pullRequest" && !covered(index)
      ? [modelNumber(index)]
      : [],
  );
  const withoutPullRequest = commits.flatMap((commit, index) =>
    commit.kind === "direct"
      ? [`${modelSha(index).slice(0, 7)} Direct change`]
      : [],
  );
  return {
    bypassing,
    validated: bypassing.length === 0 && withoutPullRequest.length === 0,
    withoutPullRequest,
  };
};

const modelCommit: fc.Arbitrary<ModelCommit> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("direct" as const),
      mergeGroup: fc.boolean(),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("pullRequest" as const),
      timeline: fc.constantFrom("queued", "direct", "removed", "requeued"),
      foreign: fc.boolean(),
      mergeGroup: fc.boolean(),
    }),
  },
);

describe("batched release history", () => {
  test("gives the per-pull-request verdict on every history, across query boundaries", () => {
    const samples = drawPropertySamples(
      fc.array(modelCommit, { maxLength: 130 }),
      { numRuns: 40 },
    );
    for (const { label, value: commits } of samples) {
      const shas = commits.map((_, index) => modelSha(index));
      const command = fakeCommand({
        commits: shas,
        eventsFor: (number) => {
          const commit = commits[number - modelNumber(0)];
          return number < FOREIGN_OFFSET && commit?.kind === "pullRequest"
            ? MODEL_TIMELINES[commit.timeline]
            : DIRECT;
        },
        pullRequestsFor: (sha, index) => {
          const commit = commits[index];
          if (commit?.kind !== "pullRequest") {
            return [];
          }
          const own = pullRequest(modelNumber(index), sha);
          return commit.foreign
            ? [
                {
                  ...pullRequest(FOREIGN_OFFSET + index, sha),
                  merge_commit_sha: BASE_SHA,
                },
                own,
              ]
            : [own];
        },
        successfulMergeGroupShas: shas.filter(
          (_, index) => commits[index]?.mergeGroup === true,
        ),
      });
      const report = check(command);
      const expected = specifiedReport(commits);

      expect(
        report.bypassingPullRequests.map(({ number }) => number),
        label,
      ).toEqual(expected.bypassing);
      expect(report.commitsWithoutPullRequest, label).toEqual(
        expected.withoutPullRequest,
      );
      expect(report.validated, label).toBe(expected.validated);
      expect(command.historyRequests, label).toHaveLength(
        Math.ceil(commits.length / 25),
      );
    }
  });
});

describe("release queue history options", () => {
  test("parses both options in either order", () => {
    const expected = {
      baseSha: BASE_SHA,
      previousTag: "v1.2.3",
      strict: false,
    };

    expect(parseOptions(["--from", "v1.2.3", "--base", BASE_SHA])).toEqual(
      expected,
    );
    expect(parseOptions(["--base", BASE_SHA, "--from", "v1.2.3"])).toEqual(
      expected,
    );
  });

  test("rejects an option value that looks like a flag", () => {
    for (const args of [
      ["--from", "--base", "--base", BASE_SHA],
      ["--from", "v1.2.3", "--base", "--from"],
    ]) {
      expect(() => parseOptions(args)).toThrow("Usage:");
    }
  });

  test("parses strict mode and the checkout to read", () => {
    expect(
      parseOptions([
        "--require",
        "--from",
        "v1.2.3",
        "--base",
        BASE_SHA,
        "--repo-dir",
        "/checkout",
      ]),
    ).toEqual({
      baseSha: BASE_SHA,
      previousTag: "v1.2.3",
      strict: true,
      repoDir: "/checkout",
    });
  });

  test("leaves the previous tag to the history when --from is omitted", () => {
    expect(parseOptions(["--base", BASE_SHA])).toEqual({
      baseSha: BASE_SHA,
      strict: false,
    });
  });

  test("rejects unknown, repeated or missing options", () => {
    for (const args of [
      ["--from", "v1.2.3"],
      ["--from", "v1.2.3", "--base", BASE_SHA, "--extra"],
      ["--from", "v1.2.3", "--base", BASE_SHA, "--require", "--require"],
      ["--from", "v1.2.3", "--from", "v1.2.4", "--base", BASE_SHA],
      ["--from", "v1.2.3", "--base", BASE_SHA, "--repo-dir"],
    ]) {
      expect(() => parseOptions(args)).toThrow("Usage:");
    }
  });
});

describe("strict release queue history", () => {
  const STRICT_ARGS = ["--require", "--from", "v1.2.3", "--base", BASE_SHA];
  const runStrict = (
    args: readonly string[],
    command: ReturnType<typeof fakeCommand>,
  ) => {
    const lines: string[] = [];
    const exitCode = runReleaseQueueHistoryCli(
      args,
      (message) => {
        lines.push(message);
        return true;
      },
      (options) =>
        assertReleaseQueueHistory({
          ...options,
          command,
          ghRetryScript: "/fake/gh-retry.sh",
        }),
    );
    return { exitCode, lines };
  };

  test("passes silently when the queue validated every commit", () => {
    expect(runStrict(STRICT_ARGS, fakeCommand())).toEqual({
      exitCode: 0,
      lines: [],
    });
  });

  test("fails with an error naming a pull request that bypassed the queue", () => {
    const { exitCode, lines } = runStrict(
      STRICT_ARGS,
      fakeCommand({ direct: [303] }),
    );

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines.at(0)).toStartWith("::error::Release history");
    expect(lines.at(0)).toContain("#303 Change 303");
  });

  test("fails for a commit without a merged pull request", () => {
    const { exitCode, lines } = runStrict(
      STRICT_ARGS,
      fakeCommand({ missingPullRequestFor: [SECOND_SHA] }),
    );

    expect(exitCode).toBe(1);
    expect(lines.at(0)).toContain("2222222 Direct release adjustment");
  });

  test("a green heavy run on the base does not excuse a bypass", () => {
    const command = fakeCommand({ direct: [202], heavySha: BASE_SHA });

    expect(runStrict(STRICT_ARGS, command).exitCode).toBe(1);
    expect(command.heavyRequests).toHaveLength(0);
    expect(command.dispatchRequests).toHaveLength(0);
  });

  test("fails when the history cannot be read", () => {
    const { exitCode, lines } = runStrict(
      STRICT_ARGS,
      fakeCommand({ truncated: [101] }),
    );

    expect(exitCode).toBe(1);
    expect(lines.at(0)).toStartWith(
      "::error::Release queue history could not be checked:",
    );
  });

  test("fails on unusable arguments", () => {
    const { exitCode, lines } = runStrict(
      ["--require", "--from", "v1.2.3"],
      fakeCommand(),
    );

    expect(exitCode).toBe(1);
    expect(lines.at(0)).toContain("Usage:");
  });

  test("the same unvalidated history stays advisory without --require", () => {
    const { exitCode, lines } = runStrict(
      ["--from", "v1.2.3", "--base", BASE_SHA],
      fakeCommand({ direct: [303] }),
    );

    expect(exitCode).toBe(0);
    expect(lines.at(0)).toStartWith("::warning::Release history");
  });
});

const REPOSITORY_ROOT = nodePath.resolve(import.meta.dirname, "..");
const historyRoots: string[] = [];

afterEach(() => {
  for (const root of historyRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const git = (cwd: string) => (command: readonly string[]) => {
  const result = Bun.spawnSync([...command], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (!result.success) {
    throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

// One linear main history: each step either lands an ordinary change or a
// version commit, and a version commit is tagged or left untagged (superseded
// by the next one).
type Step = { kind: "change" } | { kind: "version"; tagged: boolean };

type BuiltHistory = {
  // The history's tip, the base a release is prepared from.
  base: string;
  // The last tag on a commit before the base, read from the steps.
  expectedTag: string;
};

const COMMITTER = `Release <release@example.com> ${String(
  Date.parse("2026-10-01T00:00:00Z") / 1000,
)} +0000`;

const fastImportData = (text: string) =>
  `data ${String(Buffer.byteLength(text))}\n${text}\n`;

// Every history becomes its own root branch of one fixture repository, written
// by a single `git fast-import`. Each history numbers its releases under its
// own major version, so no tag is shared and none is reachable from another.
const buildHistories = (histories: readonly (readonly Step[])[]) => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-history-"));
  historyRoots.push(root);
  const run = git(root);
  run(["git", "init", "--quiet", "--bare"]);
  let stream = "";
  let mark = 0;
  const expectedTags = histories.map((steps, history) => {
    const major = String(history + 1);
    let patch = 0;
    let lastTag = "";
    let expectedTag = "";
    // The first release is always tagged, so a previous release exists.
    const allSteps: readonly Step[] = [
      { kind: "version", tagged: true },
      ...steps,
    ];
    for (const [index, step] of allSteps.entries()) {
      // Before each commit, the last tag so far is the nearest one before it.
      expectedTag = lastTag;
      mark += 1;
      if (step.kind === "version") {
        patch += 1;
      }
      const [file, content] =
        step.kind === "version"
          ? ["VERSION", `${major}.0.${String(patch)}\n`]
          : ["change.txt", `${String(index)}\n`];
      stream += `commit refs/heads/h${String(history)}\nmark :${String(mark)}\ncommitter ${COMMITTER}\n`;
      stream += fastImportData(`step ${String(index)}`);
      stream += `M 644 inline ${file}\n${fastImportData(content)}\n`;
      if (step.kind === "version" && step.tagged) {
        lastTag = `v${major}.0.${String(patch)}`;
        stream += `reset refs/tags/${lastTag}\nfrom :${String(mark)}\n\n`;
      }
    }
    return expectedTag;
  });
  const imported = Bun.spawnSync(["git", "fast-import", "--quiet"], {
    cwd: root,
    stderr: "pipe",
    stdin: Buffer.from(stream),
    stdout: "pipe",
  });
  if (!imported.success) {
    throw new Error(`git fast-import: ${imported.stderr.toString()}`);
  }
  const bases = run([
    "git",
    "rev-parse",
    ...histories.map((_, history) => `refs/heads/h${String(history)}`),
  ]).split("\n");
  const built: BuiltHistory[] = bases.map((base, history) => ({
    base,
    expectedTag: expectedTags[history] ?? "",
  }));
  return { built, run };
};

const historySteps = fc.array(
  fc.oneof(
    fc.constant<Step>({ kind: "change" }),
    fc.boolean().map<Step>((tagged) => ({ kind: "version", tagged })),
  ),
  { maxLength: 6, minLength: 1 },
);

describe("previous release tag", () => {
  test("is the nearest tag before the base, never v + an untagged VERSION", () => {
    // The histories are drawn once and built as one batch; each sample then
    // runs the real git describe against its own branch.
    const samples = drawPropertySamples(historySteps, { numRuns: 25 });
    const { built, run } = buildHistories(samples.map(({ value }) => value));
    const tags = new Set(run(["git", "tag", "--list"]).split("\n"));
    for (const [index, { label }] of samples.entries()) {
      const history = built[index];
      if (history === undefined) {
        throw new Error(`history ${String(index)} was not built`);
      }
      const previous = previousReleaseTag(history.base, run);
      expect(previous, label).toBe(history.expectedTag);
      const version = run(["git", "show", `${history.base}:VERSION`]);
      if (!tags.has(`v${version}`)) {
        expect(previous, label).not.toBe(`v${version}`);
      }
    }
  });

  test("reads the history of a base whose VERSION was never tagged", () => {
    const {
      built: [history],
      run,
    } = buildHistories([
      [
        { kind: "change" },
        { kind: "version", tagged: false },
        { kind: "change" },
      ],
    ]);
    if (history === undefined) {
      throw new Error("history was not built");
    }
    const ranges: string[] = [];
    const report = assertReleaseQueueHistory({
      baseSha: history.base,
      command: (command) => {
        if (command[0] === "git" && command[1] === "rev-list") {
          ranges.push(command.at(-1) ?? "");
          return "";
        }
        if (command[0] === "git") {
          return run(command);
        }
        return "[]";
      },
      ghRetryScript: "/fake/gh-retry.sh",
      strict: true,
    });
    expect(ranges).toEqual([`v1.0.1..${history.base}`]);
    expect(report.validated).toBe(true);
  });
});

// Every checked-in reader of the VERSION file, with why an untagged VERSION
// (a version commit superseded by the next one) cannot mislead it. A new
// reader fails here until it is classified; one that needs the previous
// release takes it from previousReleaseTag.
const VERSION_READERS: Record<string, string> = {
  ".github/ci-checks/ci-checks-rest.yml":
    "VERSION changed against the base; the previous release comes from previousReleaseTag",
  ".github/workflows/ci.yml":
    "VERSION changed in the commit, and the image build label",
  ".github/workflows/publish-npm.yml":
    "VERSION equals the release tag being published",
  ".github/workflows/release.yml": "VERSION equals the tag being built",
  "scripts/check-cli-release-coupling.ts":
    "VERSION changed against the merge base; compared with npm, not with tags",
  "scripts/check-railway-template-shape.ts": "watch pattern",
  "scripts/check-release-candidate.sh":
    "the pending version commit; its tag is the one to create",
  "scripts/check-release-changelog.sh":
    "VERSION changed against the base; names the new changelog file",
  "scripts/ci-package-scope.ts": "changed-path scope",
  "scripts/ci-plan-scope.ts": "changed-path scope",
  "scripts/ci-root-check-inputs.json": "changed-path scope",
  "scripts/prepare-maintenance-release.ts":
    "readPreviousRelease answers superseded for an untagged VERSION",
  "scripts/rehearse-migration-upgrade.sh":
    "checkout image build label; base release comes from the committed production promotion record",
  "scripts/verify-release-candidate-tree.mjs":
    "VERSION changed against main and is a supported release version",
  "scripts/verify-release-tree-proof.sh": "VERSION modified in the PR",
};
const NOT_VERSION_READERS = new Set([
  "scripts/check-parser-versions.ts",
  "scripts/desktop-release-step.ts",
  "scripts/env-catalog.ts",
]);
const VERSION_FILE_READ =
  /git show [^\n]*:VERSION\b|<\s*VERSION\b|"VERSION"|-- VERSION\b|cat VERSION\b|-f VERSION\b|\/VERSION"/u;

describe("VERSION reader census", () => {
  test("classifies every reader of the VERSION file", () => {
    const files = git(REPOSITORY_ROOT)([
      "git",
      "ls-files",
      "scripts",
      ".github",
    ])
      .split("\n")
      .filter((file) => !/\.test\.|\/fixtures?\//u.test(file));
    const readers = files
      .filter((file) => !NOT_VERSION_READERS.has(file))
      .filter((file) =>
        VERSION_FILE_READ.test(
          readFileSync(nodePath.join(REPOSITORY_ROOT, file), "utf-8"),
        ),
      )
      .toSorted();
    expect(readers).toEqual(Object.keys(VERSION_READERS).toSorted());
  });
});
