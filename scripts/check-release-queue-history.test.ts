import { describe, expect, test } from "bun:test";

import {
  assertReleaseQueueHistory,
  ReleaseQueueHistoryError,
} from "./check-release-queue-history";

const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIRST_SHA = "1111111111111111111111111111111111111111";
const SECOND_SHA = "2222222222222222222222222222222222222222";

const pullRequest = (number: number, sha: string) => ({
  html_url: `https://github.com/stella/stella/pull/${String(number)}`,
  merge_commit_sha: sha,
  merged_at: "2026-10-01T00:00:00Z",
  number,
  title: `Change ${String(number)}`,
});

const successfulQueueRun = (sha: string) => ({
  workflow_runs: [
    {
      conclusion: "success",
      event: "merge_group",
      head_sha: sha,
      path: ".github/workflows/ci.yml",
    },
  ],
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
  heavySha?: string | null;
  skipped?: readonly string[];
};

const fakeCommand = ({ heavySha = null, skipped = [] }: FakeOptions = {}) => {
  const responses = new Map<string, unknown>([
    [`commits/${FIRST_SHA}/pulls?per_page=100`, [pullRequest(101, FIRST_SHA)]],
    [
      `commits/${SECOND_SHA}/pulls?per_page=100`,
      [pullRequest(202, SECOND_SHA)],
    ],
    [`commits/${BASE_SHA}/status`, heavyStatuses(heavySha === BASE_SHA)],
  ]);
  for (const sha of [FIRST_SHA, SECOND_SHA]) {
    responses.set(
      `actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&status=success&per_page=1`,
      skipped.includes(sha) ? { workflow_runs: [] } : successfulQueueRun(sha),
    );
  }

  return (command: readonly string[]): string => {
    if (command.at(0) === "git" && command.at(1) === "rev-parse") {
      return BASE_SHA;
    }
    if (command.at(0) === "git" && command.at(1) === "rev-list") {
      return `${FIRST_SHA}\n${SECOND_SHA}`;
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
  test("allows history where every pull request used the merge queue", () => {
    expect(() => check(fakeCommand())).not.toThrow();
  });

  test("refuses a queue-skipping pull request and names its remediation", () => {
    const run = () => check(fakeCommand({ skipped: [SECOND_SHA] }));

    expect(run).toThrow(ReleaseQueueHistoryError);
    expect(run).toThrow("#202 Change 202");
    expect(run).toThrow(
      `gh workflow run main-heavy.yml --repo stella/stella --ref main -f sha=${BASE_SHA} -f release_candidate=true`,
    );
  });

  test("allows a queue-skipping pull request after the base passed main heavy", () => {
    expect(() =>
      check(fakeCommand({ heavySha: BASE_SHA, skipped: [SECOND_SHA] })),
    ).not.toThrow();
  });

  test("refuses when main heavy succeeded only on an older commit", () => {
    const olderSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(() =>
      check(fakeCommand({ heavySha: olderSha, skipped: [SECOND_SHA] })),
    ).toThrow("#202 Change 202");
  });
});
