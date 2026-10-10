import { describe, expect, test } from "bun:test";

import {
  assertReleaseQueueHistory,
  formatReleaseQueueHistoryNotice,
  parseOptions,
  ReleaseQueueHistoryError,
  releaseQueueHistoryWarning,
  runReleaseQueueHistoryCli,
} from "./check-release-queue-history";

const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIRST_SHA = "1111111111111111111111111111111111111111";
const SECOND_SHA = "2222222222222222222222222222222222222222";
const THIRD_SHA = "3333333333333333333333333333333333333333";
const FOURTH_SHA = "4444444444444444444444444444444444444444";

const pullRequest = (number: number, sha: string) => ({
  html_url: `https://github.com/stella/stella/pull/${String(number)}`,
  merge_commit_sha: sha,
  merged_at: "2026-10-01T00:00:00Z",
  number,
  title: `Change ${String(number)}`,
});

const queueTimeline = (events: readonly string[], hasPreviousPage = false) => ({
  data: {
    repository: {
      pullRequest: {
        timelineItems: {
          nodes: events.map((__typename, index) => ({
            __typename,
            createdAt: `2026-10-01T00:0${String(index)}:00Z`,
          })),
          pageInfo: { hasPreviousPage },
        },
      },
    },
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
  direct?: readonly number[];
  heavyEvent?: string;
  heavyHeadSha?: string;
  heavySha?: string | null;
  missingPullRequestFor?: readonly string[];
  removed?: readonly number[];
  truncated?: readonly number[];
  dispatchPages?: readonly (readonly object[])[];
  fourCommits?: boolean;
  successfulMergeGroupShas?: readonly string[];
};

const MERGE_GROUP_ENDPOINT =
  /^actions\/workflows\/ci\.yml\/runs\?head_sha=(\w+)&event=merge_group&status=success&per_page=1&page=1$/u;
const HEAVY_COMMIT_ENDPOINT =
  /^actions\/workflows\/main-heavy\.yml\/runs\?head_sha=(\w+)&event=(push|schedule)&status=success&per_page=1&page=1$/u;
const HEAVY_DISPATCH_ENDPOINT =
  /^actions\/workflows\/main-heavy\.yml\/runs\?event=workflow_dispatch&status=success&per_page=100&page=(\d+)$/u;

const fillerRuns = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    heavyRun(String(index).padEnd(40, "f"), MAIN_TIP_SHA, "workflow_dispatch"),
  );

const fakeCommand = ({
  direct = [],
  heavyEvent = "workflow_dispatch",
  heavyHeadSha = MAIN_TIP_SHA,
  heavySha = null,
  missingPullRequestFor = [],
  removed = [],
  dispatchPages,
  fourCommits = false,
  successfulMergeGroupShas = [THIRD_SHA],
  truncated = [],
}: FakeOptions = {}) => {
  const requests: string[] = [];
  const dispatchRequests: string[] = [];
  const timelineRequests: string[] = [];
  const heavyRequests: string[] = [];
  const responses = new Map<string, unknown>([
    [`commits/${FIRST_SHA}/pulls?per_page=100`, [pullRequest(101, FIRST_SHA)]],
    [
      `commits/${SECOND_SHA}/pulls?per_page=100`,
      [pullRequest(202, SECOND_SHA)],
    ],
    [`commits/${THIRD_SHA}/pulls?per_page=100`, [pullRequest(303, THIRD_SHA)]],
    [
      `commits/${FOURTH_SHA}/pulls?per_page=100`,
      [pullRequest(404, FOURTH_SHA)],
    ],
  ]);
  for (const number of [101, 202, 303, 404]) {
    let events = ["AddedToMergeQueueEvent", "MergedEvent"];
    if (direct.includes(number)) {
      events = ["MergedEvent"];
    } else if (removed.includes(number)) {
      events = [
        "AddedToMergeQueueEvent",
        "RemovedFromMergeQueueEvent",
        "MergedEvent",
      ];
    }
    responses.set(
      `graphql:${String(number)}`,
      queueTimeline(events, truncated.includes(number)),
    );
  }
  for (const sha of missingPullRequestFor) {
    responses.set(`commits/${sha}/pulls?per_page=100`, []);
  }

  const run = (command: readonly string[]): string => {
    if (command.at(0) === "git" && command.at(1) === "rev-parse") {
      return BASE_SHA;
    }
    if (command.at(0) === "git" && command.at(1) === "rev-list") {
      return [
        FIRST_SHA,
        SECOND_SHA,
        THIRD_SHA,
        ...(fourCommits ? [FOURTH_SHA] : []),
      ].join("\n");
    }
    if (command.at(0) === "git" && command.at(1) === "show") {
      return "2222222 Direct release adjustment";
    }
    const numberArgument = command.find((argument) =>
      argument.startsWith("number="),
    );
    const number = numberArgument?.slice("number=".length);
    if (command.at(3) === "graphql" && number) {
      timelineRequests.push(number);
      const response = responses.get(`graphql:${number}`);
      if (response !== undefined) {
        return JSON.stringify(response);
      }
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
    const mergeGroup = endpoint ? MERGE_GROUP_ENDPOINT.exec(endpoint) : null;
    if (endpoint && mergeGroup) {
      requests.push(mergeGroup[1] ?? "");
      return JSON.stringify({
        workflow_runs: successfulMergeGroupShas
          .filter((head_sha) => head_sha === mergeGroup[1])
          .map((head_sha) => ({
            conclusion: "success",
            event: "merge_group",
            head_sha,
          })),
      });
    }
    const response = endpoint ? responses.get(endpoint) : undefined;
    if (response === undefined) {
      throw new Error(`Unexpected command: ${command.join(" ")}`);
    }
    return JSON.stringify(response);
  };
  return Object.assign(run, {
    dispatchRequests,
    heavyRequests,
    requests,
    timelineRequests,
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

  test("looks up merge-group runs once per commit checked", () => {
    const command = fakeCommand();

    expect(() => check(command)).not.toThrow();
    expect(command.requests).toEqual([FIRST_SHA, SECOND_SHA, THIRD_SHA]);
  });

  test("covers a batch by a run three commits ahead", () => {
    const command = fakeCommand({
      fourCommits: true,
      successfulMergeGroupShas: [FOURTH_SHA],
    });

    expect(() => check(command)).not.toThrow();
    expect(command.requests).toEqual([
      FIRST_SHA,
      SECOND_SHA,
      THIRD_SHA,
      FOURTH_SHA,
    ]);
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
    expect(command.timelineRequests).toHaveLength(0);
    expect(command.requests).toHaveLength(0);
  });

  test("accepts a push run of main heavy whose head is the base", () => {
    const command = fakeCommand({
      heavyEvent: "push",
      heavyHeadSha: BASE_SHA,
      heavySha: MAIN_TIP_SHA,
      truncated: [101],
    });

    expect(() => check(command)).not.toThrow();
    expect(command.timelineRequests).toHaveLength(0);
  });

  test("refuses a dispatched heavy run on the base that tested another commit", () => {
    const command = fakeCommand({
      heavyHeadSha: BASE_SHA,
      heavySha: MAIN_TIP_SHA,
      truncated: [101],
    });

    expect(() => check(command)).toThrow(ReleaseQueueHistoryError);
    expect(command.timelineRequests.length).toBeGreaterThan(0);
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

describe("release queue history options", () => {
  test("parses both options in either order", () => {
    const expected = { baseSha: BASE_SHA, previousTag: "v1.2.3" };

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
});
