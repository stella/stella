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

const queueTimeline = (...events: readonly string[]) => ({
  data: {
    repository: {
      pullRequest: {
        timelineItems: {
          nodes: events.map((__typename, index) => ({
            __typename,
            createdAt: `2026-10-01T00:0${String(index)}:00Z`,
          })),
          pageInfo: { hasPreviousPage: false },
        },
      },
    },
  },
});

const heavyStatuses = (successful: boolean) => ({
  sha: BASE_SHA,
  statuses: !successful
    ? []
    : [
        {
          context: "main/heavy",
          creator: { login: "github-actions[bot]", type: "Bot" },
          state: "success",
        },
      ],
});

type FakeOptions = {
  direct?: readonly number[];
  heavySha?: string | null;
  missingPullRequestFor?: readonly string[];
  removed?: readonly number[];
  successfulMergeGroupShas?: readonly string[];
};

const fakeCommand = ({
  direct = [],
  heavySha = null,
  missingPullRequestFor = [],
  removed = [],
  successfulMergeGroupShas = [THIRD_SHA],
}: FakeOptions = {}) => {
  const responses = new Map<string, unknown>([
    [`commits/${FIRST_SHA}/pulls?per_page=100`, [pullRequest(101, FIRST_SHA)]],
    [
      `commits/${SECOND_SHA}/pulls?per_page=100`,
      [pullRequest(202, SECOND_SHA)],
    ],
    [`commits/${THIRD_SHA}/pulls?per_page=100`, [pullRequest(303, THIRD_SHA)]],
    [`commits/${BASE_SHA}/status`, heavyStatuses(heavySha === BASE_SHA)],
    [
      "actions/workflows/ci.yml/runs?event=merge_group&status=success&per_page=100",
      {
        workflow_runs: successfulMergeGroupShas.map((head_sha) => ({
          conclusion: "success",
          event: "merge_group",
          head_sha,
        })),
      },
    ],
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
    responses.set(`graphql:${String(number)}`, queueTimeline(...events));
  }
  for (const sha of missingPullRequestFor) {
    responses.set(`commits/${sha}/pulls?per_page=100`, []);
  }

  return (command: readonly string[]): string => {
    if (command.at(0) === "git" && command.at(1) === "rev-parse") {
      return BASE_SHA;
    }
    if (command.at(0) === "git" && command.at(1) === "rev-list") {
      return `${FIRST_SHA}\n${SECOND_SHA}\n${THIRD_SHA}`;
    }
    if (command.at(0) === "git" && command.at(1) === "show") {
      return "2222222 Direct release adjustment";
    }
    const numberArgument = command.find((argument) =>
      argument.startsWith("number="),
    );
    const number = numberArgument?.slice("number=".length);
    if (command.at(3) === "graphql" && number) {
      const response = responses.get(`graphql:${number}`);
      if (response !== undefined) {
        return JSON.stringify(response);
      }
    }
    const endpoint = command.at(-1)?.replace("repos/stella/stella/", "");
    const response = endpoint ? responses.get(endpoint) : undefined;
    if (response === undefined) {
      throw new Error(`Unexpected command: ${command.join(" ")}`);
    }
    return JSON.stringify(response);
  };
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
