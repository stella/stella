import { describe, expect, test } from "bun:test";

import {
  assertReleaseQueueHistory,
  ReleaseQueueHistoryError,
} from "./check-release-queue-history";

const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIRST_SHA = "1111111111111111111111111111111111111111";
const SECOND_SHA = "2222222222222222222222222222222222222222";
const THIRD_SHA = "3333333333333333333333333333333333333333";

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

const heavyRun = (sha: string, headSha: string) => ({
  conclusion: "success",
  display_title: `Main heavy suites ${sha}`,
  event: "workflow_dispatch",
  head_sha: headSha,
});

type FakeOptions = {
  direct?: readonly number[];
  heavyHeadSha?: string;
  heavySha?: string | null;
  missingPullRequestFor?: readonly string[];
  removed?: readonly number[];
  truncated?: readonly number[];
  runPages?: readonly (readonly string[])[];
  successfulMergeGroupShas?: readonly string[];
};

const RUNS_ENDPOINT =
  /^actions\/workflows\/ci\.yml\/runs\?event=merge_group&status=success&created=([^&]+)&per_page=100&page=(\d+)$/u;
const HEAVY_ENDPOINT =
  /^actions\/workflows\/main-heavy\.yml\/runs\?status=success&created=([^&]+)&per_page=100&page=1$/u;
const OLDEST_COMMIT_DATE = "2026-09-20T12:00:00+00:00";

const fillerShas = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) =>
    `${prefix}${String(index)}`.padEnd(40, "f"),
  );

const fakeCommand = ({
  direct = [],
  heavyHeadSha = MAIN_TIP_SHA,
  heavySha = null,
  missingPullRequestFor = [],
  removed = [],
  runPages,
  successfulMergeGroupShas = [THIRD_SHA],
  truncated = [],
}: FakeOptions = {}) => {
  const pages = runPages ?? [successfulMergeGroupShas];
  const requests: string[] = [];
  const timelineRequests: string[] = [];
  const heavyRequests: string[] = [];
  const responses = new Map<string, unknown>([
    [`commits/${FIRST_SHA}/pulls?per_page=100`, [pullRequest(101, FIRST_SHA)]],
    [
      `commits/${SECOND_SHA}/pulls?per_page=100`,
      [pullRequest(202, SECOND_SHA)],
    ],
    [`commits/${THIRD_SHA}/pulls?per_page=100`, [pullRequest(303, THIRD_SHA)]],
  ]);
  for (const number of [101, 202, 303]) {
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
      return `${FIRST_SHA}\n${SECOND_SHA}\n${THIRD_SHA}`;
    }
    if (command.at(0) === "git" && command.at(3) === "--format=%cI") {
      return OLDEST_COMMIT_DATE;
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
    const heavyMatch = endpoint ? HEAVY_ENDPOINT.exec(endpoint) : null;
    if (endpoint && heavyMatch) {
      heavyRequests.push(endpoint);
      expect(decodeURIComponent(heavyMatch[1] ?? "")).toBe(
        ">=2026-09-20T12:00:00.000Z",
      );
      return JSON.stringify({
        workflow_runs:
          heavySha === null ? [] : [heavyRun(heavySha, heavyHeadSha)],
      });
    }
    const runsMatch = endpoint ? RUNS_ENDPOINT.exec(endpoint) : null;
    if (endpoint && runsMatch) {
      requests.push(endpoint);
      expect(decodeURIComponent(runsMatch[1] ?? "")).toBe(
        ">=2026-09-13T12:00:00.000Z",
      );
      const page = pages[Number(runsMatch[2]) - 1] ?? [];
      return JSON.stringify({
        workflow_runs: page.map((head_sha) => ({
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
  return Object.assign(run, { heavyRequests, requests, timelineRequests });
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

  test("finds a required merge-group run on the second page", () => {
    const command = fakeCommand({
      runPages: [fillerShas(100, "a"), [THIRD_SHA]],
    });

    expect(() => check(command)).not.toThrow();
    expect(command.requests).toHaveLength(2);
  });

  test("stops paging at the first short page", () => {
    const command = fakeCommand({
      runPages: [fillerShas(100, "a"), fillerShas(100, "b"), [THIRD_SHA]],
    });

    expect(() => check(command)).not.toThrow();
    expect(command.requests).toHaveLength(3);
  });

  test("refuses when the run list never ends within the page limit", () => {
    const full = fillerShas(100, "a");
    const command = fakeCommand({
      runPages: Array.from({ length: 25 }, () => full),
    });

    expect(() => check(command)).toThrow(ReleaseQueueHistoryError);
    expect(() => check(command)).toThrow("exceed 20 pages of 100");
    expect(command.requests).toHaveLength(40);
  });

  test("accepts a green heavy base without inspecting queue history", () => {
    const command = fakeCommand({ heavySha: BASE_SHA, truncated: [101] });

    expect(() => check(command)).not.toThrow();
    expect(command.heavyRequests).toHaveLength(1);
    expect(command.timelineRequests).toHaveLength(0);
    expect(command.requests).toHaveLength(0);
  });

  test("accepts a push run of main heavy whose head is the base", () => {
    const command = fakeCommand({
      heavyHeadSha: BASE_SHA,
      heavySha: MAIN_TIP_SHA,
      truncated: [101],
    });

    expect(() => check(command)).not.toThrow();
    expect(command.timelineRequests).toHaveLength(0);
  });

  test("fails closed on a truncated timeline without a green heavy base", () => {
    const run = () => check(fakeCommand({ truncated: [101] }));

    expect(run).toThrow(ReleaseQueueHistoryError);
    expect(run).toThrow(
      "Timeline for pull request #101 returned an unexpected payload",
    );
  });

  test("refuses queued merges with no successful merge-group run", () => {
    const run = () => check(fakeCommand({ successfulMergeGroupShas: [] }));

    expect(run).toThrow("#101 Change 101");
    expect(run).toThrow("#202 Change 202");
    expect(run).toThrow("#303 Change 303");
  });

  test("does not carry merge-group validation across a direct push", () => {
    const run = () =>
      check(fakeCommand({ missingPullRequestFor: [SECOND_SHA] }));

    expect(run).toThrow("#101 Change 101");
    expect(run).toThrow("2222222 Direct release adjustment");
  });

  test("refuses a pull request removed from the queue before a direct merge", () => {
    const run = () => check(fakeCommand({ removed: [202] }));

    expect(run).toThrow(ReleaseQueueHistoryError);
    expect(run).toThrow("#202 Change 202");
    expect(run).toThrow(
      `gh workflow run main-heavy.yml --repo stella/stella --ref main -f sha=${BASE_SHA} -f release_candidate=true`,
    );
  });

  test("refuses an administrator merge with no queue events", () => {
    expect(() => check(fakeCommand({ direct: [303] }))).toThrow(
      "#303 Change 303",
    );
  });

  test("allows a direct merge after the base passed main heavy", () => {
    expect(() =>
      check(fakeCommand({ direct: [202], heavySha: BASE_SHA })),
    ).not.toThrow();
  });

  test("refuses a commit without an associated merged pull request", () => {
    expect(() =>
      check(fakeCommand({ missingPullRequestFor: [SECOND_SHA] })),
    ).toThrow("2222222 Direct release adjustment");
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

  test("refuses when main heavy succeeded only on an older commit", () => {
    const olderSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(() =>
      check(fakeCommand({ direct: [202], heavySha: olderSha })),
    ).toThrow("#202 Change 202");
  });
});
