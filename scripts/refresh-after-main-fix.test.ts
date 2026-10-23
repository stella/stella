import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Gh } from "./flaky-test-history";
import {
  jobFamily,
  type MainRun,
  paceRefreshes,
  pairKey,
  mainIsRed,
  plan,
  type PullRequestEvidence,
  recheckRefresh,
  redWindows,
  type RedWindow,
  selectRefreshes,
  type Selected,
} from "./refresh-after-main-fix";

const at = (hour: number) =>
  new Date(Date.UTC(2026, 9, 20, hour)).toISOString();
const NOW = new Date(Date.UTC(2026, 9, 21, 12));

const TESTS = { job: "suites / ci-tests (api-2)", step: "Run tests" };
const LINT = { job: "suites / ci-checks-policy", step: "Lint" };
const OWN = { job: "ci-web (shard-1)", step: "Build web" };

let nextId = 1;
const run = (
  hour: number,
  conclusion: string | null,
  overrides: Partial<MainRun> = {},
): MainRun => ({
  id: nextId++,
  workflow: "main-pr-depth.yml",
  event: "schedule",
  conclusion,
  createdAt: at(hour),
  updatedAt: at(hour + 1),
  headSha: "a".repeat(40),
  suitesEvaluated: conclusion === "success",
  failedPairs: conclusion === "failure" ? [TESTS] : null,
  ...overrides,
});

// Green at 1, red at 2 and 3 (two failed pairs), green again at 6.
const closedWindowRuns = (): MainRun[] => [
  run(1, "success"),
  run(2, "failure"),
  run(3, "failure", { failedPairs: [LINT, { job: "ci-result", step: "x" }] }),
  run(6, "success"),
];

const pull = (
  overrides: Partial<PullRequestEvidence> = {},
): PullRequestEvidence => ({
  number: 10,
  state: "open",
  draft: false,
  baseRef: "main",
  baseRepository: "owner/repo",
  headRepository: "owner/repo",
  headSha: "b".repeat(40),
  labels: [],
  inMergeQueue: false,
  latestRun: {
    id: 500,
    event: "pull_request",
    conclusion: "failure",
    createdAt: at(4),
    headSha: "b".repeat(40),
  },
  failedPairs: [
    { job: "ci-tests (api-1)", step: "Run tests" },
    { job: "ci-result", step: "Evaluate CI outcome" },
  ],
  headMainMergeAt: null,
  ...overrides,
});

const select = (
  pullRequests: PullRequestEvidence[],
  runs: MainRun[] = closedWindowRuns(),
) =>
  selectRefreshes({ windows: redWindows(runs), pullRequests, now: NOW }).map(
    ({ number }) => number,
  );

describe("redWindows", () => {
  test("a window opens on failure and closes on the next success", () => {
    const [window, ...rest] = redWindows(closedWindowRuns());
    expect(rest).toEqual([]);
    expect(window).toMatchObject({
      workflow: "main-pr-depth.yml",
      openedAt: at(2),
      closedAt: at(6),
    });
    expect([...(window?.pairs ?? [])].toSorted()).toEqual(
      [pairKey(TESTS), pairKey(LINT)].toSorted(),
    );
  });

  test("an open window is not returned and selects nothing", () => {
    const runs = [run(1, "success"), run(2, "failure"), run(3, "failure")];
    expect(redWindows(runs)).toEqual([]);
    expect(select([pull()], runs)).toEqual([]);
  });

  test("a success that did not evaluate the suites does not close a window", () => {
    const runs = [
      run(1, "success"),
      run(2, "failure"),
      run(3, "success", { suitesEvaluated: false }),
    ];
    expect(redWindows(runs)).toEqual([]);
  });

  test("a window without a green run before it is truncated evidence", () => {
    expect(redWindows([run(2, "failure"), run(6, "success")])).toEqual([]);
  });

  test("a failed run with an unreadable or empty digest drops its window", () => {
    for (const failedPairs of [null, [], [{ job: "ci-result", step: "x" }]]) {
      const runs = closedWindowRuns();
      runs.splice(2, 0, run(2.5, "failure", { failedPairs }));
      expect(redWindows(runs)).toEqual([]);
    }
  });

  test("dispatched runs and other workflows' runs stay apart", () => {
    const runs = [
      run(1, "success"),
      run(2, "failure", { event: "workflow_dispatch" }),
      run(3, "failure", { workflow: "main-heavy.yml" }),
      run(6, "success"),
    ];
    expect(redWindows(runs)).toEqual([]);
  });
});

describe("job families", () => {
  test("strip the reusable-workflow prefix and the shard suffix once", () => {
    expect(jobFamily("suites / ci-tests (api-2)")).toBe("ci-tests");
    expect(jobFamily("ci-tests (api-1)")).toBe("ci-tests");
    expect(jobFamily("ci-checks-policy")).toBe("ci-checks-policy");
    expect(jobFamily("suites / suites / x")).toBe("suites / x");
    expect(
      pairKey({ job: "suites / ci-tests (api-2)", step: "Run tests" }),
    ).toBe(pairKey({ job: "ci-tests (api-1)", step: "Run tests" }));
    expect(pairKey({ job: "ci-tests", step: "Run tests" })).not.toBe(
      pairKey({ job: "ci-tests", step: "Run tests (retry)" }),
    );
  });
});

describe("selectRefreshes", () => {
  test("selects a pull request whose failures are a subset of the window's", () => {
    expect(select([pull()])).toEqual([10]);
    expect(
      select([pull({ failedPairs: [{ ...TESTS }, { ...LINT }] })]),
    ).toEqual([10]);
  });

  test("one extra failed check of its own excludes it", () => {
    expect(select([pull({ failedPairs: [TESTS, OWN] })])).toEqual([]);
    expect(
      select([pull({ failedPairs: [{ job: TESTS.job, step: "Other" }] })]),
    ).toEqual([]);
  });

  test("a run created before the window opened or after it closed is excluded", () => {
    for (const hour of [1, 7]) {
      const latestRun = {
        id: 500,
        event: "pull_request",
        conclusion: "failure",
        createdAt: at(hour),
        headSha: "b".repeat(40),
      };
      expect(select([pull({ latestRun })])).toEqual([]);
    }
  });

  test("its own state excludes it", () => {
    for (const overrides of [
      { draft: true },
      { inMergeQueue: true },
      { labels: ["hold"] },
      { headRepository: "fork/repo" },
      { headRepository: null },
      { baseRef: "release" },
      { state: "closed" },
    ] satisfies Partial<PullRequestEvidence>[]) {
      expect(select([pull(overrides)])).toEqual([]);
    }
  });

  test("an empty or unreadable digest excludes it", () => {
    expect(select([pull({ failedPairs: null })])).toEqual([]);
    expect(select([pull({ failedPairs: [] })])).toEqual([]);
    expect(
      select([pull({ failedPairs: [{ job: "ci-result", step: "x" }] })]),
    ).toEqual([]);
  });

  test("only a failed pull_request run of the current head counts", () => {
    const latestRun = pull().latestRun;
    if (latestRun === null) {
      expect.unreachable("fixture has a run");
    }
    for (const overrides of [
      { conclusion: "success" },
      { conclusion: null },
      { event: "merge_group" },
      { headSha: "c".repeat(40) },
    ]) {
      expect(
        select([pull({ latestRun: { ...latestRun, ...overrides } })]),
      ).toEqual([]);
    }
    expect(select([pull({ latestRun: null })])).toEqual([]);
  });

  test("a head that already merged main after the window closed is skipped", () => {
    expect(select([pull({ headMainMergeAt: at(7) })])).toEqual([]);
    expect(select([pull({ headMainMergeAt: at(6) })])).toEqual([]);
    expect(select([pull({ headMainMergeAt: "not a date" })])).toEqual([]);
    // A merge of main from before the fix is stale.
    expect(select([pull({ headMainMergeAt: at(3) })])).toEqual([10]);
  });

  test("a window closing after now is ignored", () => {
    expect(
      selectRefreshes({
        windows: redWindows(closedWindowRuns()),
        pullRequests: [pull()],
        now: new Date(Date.parse(at(5))),
      }),
    ).toEqual([]);
  });
});

describe("paceRefreshes", () => {
  const window = (openedAt: string): RedWindow => ({
    workflow: "main-pr-depth.yml",
    openedAt,
    closedAt: at(9),
    closingRunId: 1,
    pairs: new Set(),
  });
  const selected: Selected[] = [
    { number: 30, headSha: "c", runId: 3, window: window(at(2)) },
    { number: 20, headSha: "b", runId: 2, window: window(at(2)) },
    { number: 5, headSha: "a", runId: 1, window: window(at(4)) },
    { number: 40, headSha: "d", runId: 4, window: window(at(1)) },
  ];
  const numbers = (paced: Selected[]) => paced.map(({ number }) => number);

  test("returns none while a merge group is queued", () => {
    expect(
      paceRefreshes({
        selected,
        inFlightPullRequestRuns: 0,
        queuedMergeGroups: 1,
      }),
    ).toEqual([]);
  });

  test("caps at the limit minus in-flight runs, oldest window first", () => {
    const pace = (inFlightPullRequestRuns: number, limit?: number) =>
      numbers(
        paceRefreshes({
          selected,
          inFlightPullRequestRuns,
          queuedMergeGroups: 0,
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    expect(pace(0)).toEqual([40, 20, 30]);
    expect(pace(1)).toEqual([40, 20]);
    expect(pace(3)).toEqual([]);
    expect(pace(7)).toEqual([]);
    expect(pace(0, 10)).toEqual([40, 20, 30, 5]);
    expect(pace(-1)).toEqual([]);
    expect(pace(Number.NaN)).toEqual([]);
  });
});

describe("plan", () => {
  const apiRun = (
    id: number,
    hour: number,
    conclusion: string | null,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    event: "schedule",
    conclusion,
    created_at: at(hour),
    updated_at: at(hour + 1),
    head_sha: "a".repeat(40),
    ...extra,
  });
  const digest = (failures: { job: string; step: string }[]) =>
    JSON.stringify({ version: 1, run_id: "1", run_attempt: "1", failures });
  const page = (runs: unknown[], total = runs.length) =>
    Result.ok(JSON.stringify([{ total_count: total, workflow_runs: runs }]));

  // Main green at 1, red at 2 and 3, green at 6; one pull request whose run
  // at 4 failed only a check main failed then.
  const fakeGh = ({ truncate = false, redAgain = false } = {}) => {
    const calls: string[] = [];
    const gh: Gh = async (args) => {
      calls.push(args.join(" "));
      const [command, ...rest] = args;
      const endpoint = rest.at(-1) ?? "";
      if (command === "run") {
        const dir = rest.at(rest.indexOf("--dir") + 1) ?? "";
        mkdirSync(dir, { recursive: true });
        const failures =
          rest.at(1) === "3"
            ? [{ job: "suites / ci-checks-policy", step: "Lint" }]
            : [{ job: "suites / ci-tests (api-2)", step: "Run tests" }];
        writeFileSync(path.join(dir, "ci-failures.json"), digest(failures));
        return Result.ok("");
      }
      if (rest[0] === "graphql") {
        return Result.ok(
          JSON.stringify({
            data: {
              repository: {
                mergeQueue: { entries: { totalCount: 0, nodes: [] } },
              },
            },
          }),
        );
      }
      if (endpoint.includes("/workflows/main-pr-depth.yml/runs")) {
        const runs = endpoint.includes("created=2026-10-20")
          ? [
              apiRun(1, 1, "success"),
              apiRun(2, 2, "failure"),
              apiRun(3, 3, "failure"),
              apiRun(4, 6, "success"),
              ...(redAgain ? [apiRun(5, 8, "failure")] : []),
            ]
          : [];
        return page(runs, runs.length + (truncate && runs.length > 0 ? 1 : 0));
      }
      if (endpoint.includes("/workflows/main-heavy.yml/runs")) {
        return page([]);
      }
      const artifacts = /\/actions\/runs\/(\d+)\/artifacts/u.exec(endpoint);
      if (artifacts !== null) {
        const names = ["2", "3"].includes(artifacts[1] ?? "")
          ? ["ci-failures", "ci-required-summary"]
          : ["ci-required-summary"];
        return Result.ok(
          JSON.stringify({
            total_count: names.length,
            artifacts: names.map((name) => ({ name, expired: false })),
          }),
        );
      }
      if (endpoint.includes("/pulls?")) {
        return Result.ok(
          JSON.stringify([
            [
              {
                number: 10,
                state: "open",
                draft: false,
                labels: [],
                head: { sha: "b".repeat(40), repo: { full_name: "o/r" } },
                base: { ref: "main", repo: { full_name: "o/r" } },
              },
            ],
          ]),
        );
      }
      if (endpoint.includes("event=pull_request&head_sha=")) {
        return page([
          apiRun(500, 4, "failure", {
            event: "pull_request",
            head_sha: "b".repeat(40),
          }),
        ]);
      }
      if (endpoint.includes("/commits/")) {
        return Result.ok(
          JSON.stringify({
            parents: [{ sha: "c".repeat(40) }],
            commit: { committer: { date: at(0) } },
          }),
        );
      }
      if (endpoint.includes("status=")) {
        return Result.ok(
          JSON.stringify({
            total_count: endpoint.includes("in_progress") ? 1 : 0,
          }),
        );
      }
      return Result.ok("unexpected");
    };
    return { gh, calls };
  };

  const options = (gh: Gh) => ({
    gh,
    repository: "o/r",
    now: NOW,
    workdir: mkdtempSync(path.join(tmpdir(), "refresh-after-main-fix-test-")),
  });

  test("collects main and pull request evidence into a paced refresh", async () => {
    const { gh, calls } = fakeGh();
    const result = await plan(options(gh));
    if (result.isErr()) {
      expect.unreachable(result.error.message);
    }
    expect(result.value.windows).toHaveLength(1);
    expect(result.value.inFlightPullRequestRuns).toBe(1);
    expect(result.value.paced.map(({ number }) => number)).toEqual([10]);
    // Four UTC days per main workflow, listed day by day.
    expect(
      calls.filter((call) => call.includes("main-pr-depth.yml/runs")),
    ).toHaveLength(4);
  });

  test("a window that closed is not refreshed onto a main that failed again", async () => {
    const result = await plan(options(fakeGh({ redAgain: true }).gh));
    if (result.isErr()) {
      expect.unreachable(result.error.message);
    }
    expect(result.value.windows).toHaveLength(1);
    expect(result.value.selected).toEqual([]);
    expect(result.value.paced).toEqual([]);
  });

  test("a day listing short of its total_count fails instead of selecting", async () => {
    const result = await plan(options(fakeGh({ truncate: true }).gh));
    expect(result.isErr()).toBe(true);
  });
});

test("main is red while any main workflow's latest verdict is not green", () => {
  const depth = (hour: number, conclusion: string) =>
    run(hour, conclusion, { suitesEvaluated: true });
  const heavy = (hour: number, conclusion: string) =>
    run(hour, conclusion, {
      workflow: "main-heavy.yml",
      suitesEvaluated: true,
    });
  expect(mainIsRed([depth(1, "success"), depth(2, "failure")])).toBe(true);
  expect(
    mainIsRed([depth(1, "success"), depth(2, "failure"), depth(3, "success")]),
  ).toBe(false);
  expect(
    mainIsRed([
      depth(1, "success"),
      depth(2, "failure"),
      depth(3, "success"),
      depth(4, "failure"),
    ]),
  ).toBe(true);
  expect(mainIsRed([depth(3, "success"), heavy(4, "failure")])).toBe(true);
  // A cancelled run has no verdict and changes nothing.
  expect(mainIsRed([depth(3, "success"), depth(4, "cancelled")])).toBe(false);
});

describe("the recheck right before an update", () => {
  const HEAD = "a".repeat(40);
  // The pull request as selected; each case changes one fact after selection.
  const recheck = async (
    change: { labels?: string[]; head?: string; draft?: boolean },
    queued: number[] = [],
  ) => {
    const gh: Gh = async (args) => {
      if (args.includes("graphql")) {
        return Result.ok(
          JSON.stringify({
            data: {
              repository: {
                mergeQueue: {
                  entries: {
                    totalCount: queued.length,
                    nodes: queued.map((number) => ({
                      pullRequest: { number },
                    })),
                  },
                },
              },
            },
          }),
        );
      }
      expect(args.at(-1)).toBe("repos/o/r/pulls/7");
      return Result.ok(
        JSON.stringify({
          number: 7,
          state: "open",
          draft: change.draft ?? false,
          labels: (change.labels ?? []).map((name) => ({ name })),
          head: { sha: change.head ?? HEAD, repo: { full_name: "o/r" } },
          base: { ref: "main", repo: { full_name: "o/r" } },
        }),
      );
    };
    return recheckRefresh(
      { gh, repository: "o/r" },
      { number: 7, headSha: HEAD },
    );
  };

  test("an unchanged pull request stays eligible", async () => {
    expect((await recheck({})).unwrap()).toBeUndefined();
  });

  test("a hold, a queue entry or a draft that arrived without a commit skips it", async () => {
    expect((await recheck({ labels: ["hold"] })).unwrap()).toBe("held");
    expect((await recheck({}, [7])).unwrap()).toBe("in the merge queue");
    expect((await recheck({ draft: true })).unwrap()).toBe("draft");
  });

  test("a moved head skips it", async () => {
    expect((await recheck({ head: "b".repeat(40) })).unwrap()).toBe(
      "head moved",
    );
  });
});
