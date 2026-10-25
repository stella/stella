import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FULL_TEST_JOB_SHARDS } from "./api-test-shard-plan";
import { digestFile, type FailureRecord } from "./ci-failure-digest";
import {
  buildHistory,
  collectEvidence,
  type Evidence,
  fetchLatestHistory,
  findFlakyChecks,
  type Gh,
  GhCommandError,
  HISTORY_ARTIFACT,
  HISTORY_FILE,
  HISTORY_WINDOW_DAYS,
  jobFamily,
  jobSummary,
  type Observation,
  PROPOSAL_THRESHOLD,
  proposalBody,
  PROPOSED_QUARANTINE_DAYS,
  proposeQuarantine,
  quarantineArtifactName,
  quarantineCandidates,
  resolveOwners,
  resolveTestFile,
} from "./flaky-test-history";
import {
  DAY_MS,
  parseRegistry,
  type QuarantineEntry,
  type Registry,
  serializeRegistry,
} from "./flaky-test-quarantine";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const FILE = "apps/web/src/widget.test.ts";
const ID = `${FILE}::widget > renders`;
const files = new Set([FILE, "packages/kit/src/other.test.ts"]);
const exists = (file: string): boolean => files.has(file);
const sha = (index: number): string => index.toString(16).padStart(40, "0");
const at = (daysAgo: number): string =>
  new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
const empty: Registry = { entries: [] };

const entry = (overrides: Partial<QuarantineEntry> = {}): QuarantineEntry => ({
  id: ID,
  owner: "octocat",
  reason: "Fails intermittently.",
  created: "2026-10-10",
  expires: "2026-10-24",
  ...overrides,
});

const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  runs: [],
  digests: [],
  flakeReports: [],
  quarantineReports: [],
  ...overrides,
});

const retryPass = (commit: number, daysAgo = 1): Observation => ({
  kind: "retry-pass",
  at: at(daysAgo),
  headSha: sha(commit),
  url: `https://github.com/stella/stella/actions/runs/${commit}`,
});

describe("test identity resolution", () => {
  test("maps a package scope and its file header to the repository path", () => {
    expect(
      resolveTestFile(
        { scope: "@stll/web", file: "src/widget.test.ts", name: "x" },
        exists,
      ),
    ).toBe(FILE);
    expect(
      resolveTestFile(
        { scope: "@stll/web", file: "./src/widget.test.ts", name: "x" },
        exists,
      ),
    ).toBe(FILE);
  });

  test("refuses unknown scopes, missing files and escaping headers", () => {
    for (const failed of [
      { scope: "web", file: "src/widget.test.ts", name: "x" },
      { scope: "@stll/web", file: "src/gone.test.ts", name: "x" },
      { scope: "@stll/web", file: "../web/src/widget.test.ts", name: "x" },
      { scope: "@stll/web", file: `/abs/${FILE}`, name: "x" },
    ]) {
      expect(resolveTestFile(failed, exists)).toBeUndefined();
    }
  });
});

describe("flake evidence", () => {
  const failure = {
    headSha: sha(1),
    createdAt: at(2),
    url: "https://github.com/stella/stella/actions/runs/1",
    tests: [
      {
        scope: "@stll/web",
        file: "src/widget.test.ts",
        name: "widget > renders",
        job: "ci-tests (rest-web)",
        step: "Test web",
      },
    ],
    checks: [{ job: "ci-tests (rest-web)", step: "Test web" }],
  } satisfies Evidence["digests"][number];

  test("a same-head success that skipped the test step is not a retry flake", () => {
    const tests = buildHistory({
      evidence: evidence({
        digests: [failure],
        runs: [
          {
            headSha: sha(1),
            conclusion: "success",
            startedAt: at(1.9),
            successfulChecks: [
              { job: "ci-tests (rest-web)", step: "Checkout" },
            ],
          },
        ],
      }),
      exists,
    });
    expect(tests[ID]).toBeUndefined();
  });

  test("a same-head success that ran and passed the test step is a retry flake", () => {
    const tests = buildHistory({
      evidence: evidence({
        digests: [failure],
        runs: [
          {
            headSha: sha(1),
            conclusion: "success",
            startedAt: at(1.9),
            successfulChecks: [{ job: "ci-tests (api)", step: "Test web" }],
          },
        ],
      }),
      exists,
    });
    expect(tests[ID]).toEqual([
      {
        kind: "retry-pass",
        at: failure.createdAt,
        headSha: sha(1),
        url: failure.url,
      },
    ]);
  });

  test("a failure without a later success on the same commit is not flake evidence", () => {
    for (const runs of [
      [{ headSha: sha(1), conclusion: "failure", startedAt: at(1) }],
      [{ headSha: sha(1), conclusion: "success", startedAt: at(3) }],
      [{ headSha: sha(2), conclusion: "success", startedAt: at(1) }],
    ]) {
      expect(
        buildHistory({
          evidence: evidence({ digests: [failure], runs }),
          exists,
        }),
      ).toEqual({});
    }
  });

  test("repeats that failed some trials are flakes; failing every trial is not", () => {
    const report = {
      headSha: sha(3),
      createdAt: at(1),
      url: "https://github.com/stella/stella/actions/runs/3",
      results: [
        {
          file: FILE,
          runs: 20,
          failedTests: { "widget > renders": 2, "widget > broken": 20 },
        },
      ],
    };
    const tests = buildHistory({
      evidence: evidence({ flakeReports: [report] }),
      exists,
    });
    expect(Object.keys(tests)).toEqual([ID]);
    expect(tests[ID]?.at(0)).toMatchObject({
      kind: "repeat-flake",
      failures: 2,
      runs: 20,
    });
  });

  test("quarantine reports become dated outcomes, newest first", () => {
    const source = (days: number) => ({
      headSha: sha(days),
      createdAt: at(days),
      url: `https://github.com/stella/stella/actions/runs/${days}`,
    });
    const tests = buildHistory({
      evidence: evidence({
        quarantineReports: [
          {
            ...source(3),
            records: [{ type: "passed", id: ID, durationMs: 4 }],
          },
          {
            ...source(1),
            records: [
              { type: "loaded", file: FILE },
              { type: "registered", id: ID },
              {
                type: "failed",
                id: ID,
                durationMs: 9,
                message: "timed out after 50ms",
              },
            ],
          },
        ],
      }),
      exists,
    });
    expect(tests[ID]?.map(({ kind }) => kind)).toEqual([
      "quarantined-fail",
      "quarantined-pass",
    ]);
  });

  test("normalises reusable-workflow and shard job names to one family", () => {
    expect(jobFamily("suites / ci-tests (api-2)")).toBe("ci-tests");
    expect(jobFamily("ci-tests (api-1)")).toBe("ci-tests");
  });

  const branchFailure = (
    commit: number,
    branch: string,
    daysAgo: number,
    fullDepth = false,
  ): Evidence["digests"][number] => ({
    ...failure,
    headSha: sha(commit),
    headBranch: branch,
    fullDepth,
    createdAt: at(daysAgo),
    url: `https://github.com/stella/stella/actions/runs/${commit}`,
  });

  test("cross-branch failures with an intervening main pass become evidence", () => {
    const tests = buildHistory({
      evidence: evidence({
        digests: [
          branchFailure(1, "feature-a", 3),
          branchFailure(2, "feature-a", 2),
          branchFailure(3, "feature-b", 1),
        ],
        runs: [
          {
            headSha: sha(9),
            headBranch: "main",
            fullDepth: true,
            conclusion: "success",
            startedAt: at(1.5),
            successfulChecks: [
              { job: "suites / ci-tests (rest-web-2)", step: "Test web" },
            ],
          },
        ],
      }),
      exists,
    });
    const candidates = quarantineCandidates({
      tests,
      registry: empty,
      now: NOW,
      exists,
    });
    expect(candidates.at(0)).toMatchObject({
      evidenceKind: "cross-branch-fail",
      branches: 2,
    });
    expect(candidates.at(0)?.commits).toHaveLength(3);
    const proposal = proposeQuarantine({
      registry: empty,
      candidates,
      owners: new Map([[FILE, "octocat"]]),
      now: NOW,
    });
    expect(proposal.added.at(0)?.reason).toBe(
      "Cross-branch failure: failed on 3 commits across 2 branches while main passed it.",
    );
    expect(
      quarantineCandidates({
        tests,
        registry: { entries: [entry()] },
        now: NOW,
        exists,
      }),
    ).toEqual([]);
  });

  test("cross-branch failures are rejected when main did not pass the step", () => {
    const digests = [
      branchFailure(1, "feature-a", 3),
      branchFailure(2, "feature-a", 2),
      branchFailure(3, "feature-b", 1),
    ];
    for (const successfulChecks of [
      [],
      [{ job: "suites / ci-tests (rest-web)", step: "Checkout" }],
    ]) {
      expect(
        buildHistory({
          evidence: evidence({
            digests,
            runs: [
              {
                headSha: sha(9),
                headBranch: "main",
                fullDepth: true,
                conclusion: "failure",
                startedAt: at(1.5),
                successfulChecks,
              },
            ],
          }),
          exists,
        })[ID],
      ).toBeUndefined();
    }
  });

  test("three failures on one branch are not cross-branch evidence", () => {
    const tests = buildHistory({
      evidence: evidence({
        digests: [1, 2, 3].map((commit) =>
          branchFailure(commit, "feature-a", 4 - commit),
        ),
        runs: [
          {
            headSha: sha(9),
            headBranch: "main",
            fullDepth: true,
            conclusion: "success",
            startedAt: at(1.5),
            successfulChecks: [
              { job: "suites / ci-tests (rest-web)", step: "Test web" },
            ],
          },
        ],
      }),
      exists,
    });
    expect(tests[ID]).toBeUndefined();
  });

  test("a full-depth main fail/pass/fail becomes evidence, but fail/pass does not", () => {
    const first = branchFailure(10, "main", 3, true);
    const second = branchFailure(12, "main", 1, true);
    const pass = {
      headSha: sha(11),
      headBranch: "main",
      fullDepth: true,
      conclusion: "success",
      startedAt: at(2),
      successfulChecks: [
        { job: "suites / ci-tests (rest-web)", step: "Test web" },
      ],
    };
    expect(
      buildHistory({
        evidence: evidence({ digests: [first], runs: [pass] }),
        exists,
      })[ID],
    ).toBeUndefined();
    const tests = buildHistory({
      evidence: evidence({ digests: [first, second], runs: [pass] }),
      exists,
    });
    expect(tests[ID]?.map(({ kind }) => kind)).toContain("main-flip");
    expect(
      quarantineCandidates({ tests, registry: empty, now: NOW, exists }).at(0),
    ).toMatchObject({ evidenceKind: "main-flip" });
  });
});

describe("quarantine proposals", () => {
  test(`propose after ${PROPOSAL_THRESHOLD} distinct commits within ${HISTORY_WINDOW_DAYS} days`, () => {
    const below = Array.from({ length: PROPOSAL_THRESHOLD - 1 }, (_, index) =>
      retryPass(index),
    );
    // A second failure on an already-counted commit adds nothing.
    const repeated = [...below, retryPass(0, 2)];
    const stale = [...below, retryPass(99, HISTORY_WINDOW_DAYS + 1)];
    const enough = [...below, retryPass(PROPOSAL_THRESHOLD)];
    const candidates = (observations: Observation[]) =>
      quarantineCandidates({
        tests: { [ID]: observations },
        registry: empty,
        now: NOW,
        exists,
      });
    expect(candidates(below)).toEqual([]);
    expect(candidates(repeated)).toEqual([]);
    expect(candidates(stale)).toEqual([]);
    expect(
      candidates(enough).map(({ id, commits }) => [id, commits.length]),
    ).toEqual([[ID, PROPOSAL_THRESHOLD]]);
  });

  test("quarantined, deleted and quarantine-only tests are never proposed", () => {
    const enough = Array.from({ length: PROPOSAL_THRESHOLD }, (_, index) =>
      retryPass(index),
    );
    expect(
      quarantineCandidates({
        tests: { [ID]: enough },
        registry: { entries: [entry()] },
        now: NOW,
        exists,
      }),
    ).toEqual([]);
    expect(
      quarantineCandidates({
        tests: { "apps/web/src/gone.test.ts::x": enough },
        registry: empty,
        now: NOW,
        exists,
      }),
    ).toEqual([]);
    const quarantinedFailures = enough.map((observation): Observation => ({
      ...observation,
      kind: "quarantined-fail",
      message: "x",
    }));
    expect(
      quarantineCandidates({
        tests: { [ID]: quarantinedFailures },
        registry: empty,
        now: NOW,
        exists,
      }),
    ).toEqual([]);
  });

  test("proposed entries are valid, owned and expire after the proposal window", () => {
    const enough = Array.from({ length: PROPOSAL_THRESHOLD }, (_, index) =>
      retryPass(index),
    );
    const other = "packages/kit/src/other.test.ts::other";
    const candidates = quarantineCandidates({
      tests: { [ID]: enough, [other]: enough },
      registry: empty,
      now: NOW,
      exists,
    });
    const proposal = proposeQuarantine({
      registry: { entries: [entry({ id: "apps/web/src/a.test.ts::kept" })] },
      candidates,
      owners: new Map([[FILE, "octocat"]]),
      now: NOW,
    });
    expect(proposal.added.map(({ id }) => id)).toEqual([ID]);
    expect(proposal.unowned.map(({ id }) => id)).toEqual([other]);
    expect(proposal.added.at(0)).toMatchObject({
      owner: "octocat",
      created: "2026-10-17",
      expires: new Date(NOW.getTime() + PROPOSED_QUARANTINE_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10),
    });
    expect(parseRegistry(proposal.registry)).toMatchObject({ status: "valid" });
  });
});

describe("job summary", () => {
  test("a quarantined failure annotates without failing and shows its history", () => {
    const summary = jobSummary({
      registry: { entries: [entry()] },
      records: [
        { type: "loaded", file: FILE },
        { type: "registered", id: ID },
        {
          type: "failed",
          id: ID,
          durationMs: 3,
          message: "expected 1 to be 2",
        },
      ],
      history: {
        generatedAt: NOW.toISOString(),
        tests: { [ID]: [retryPass(1)] },
        flakyChecks: [],
      },
      now: NOW,
    });
    expect(summary.annotations).toHaveLength(1);
    expect(summary.annotations.at(0)).toStartWith(`::warning file=${FILE},`);
    expect(summary.annotations.at(0)).toContain("does not fail this run");
    expect(summary.markdown).toContain("failed: expected 1 to be 2");
    expect(summary.markdown).toContain("1 flaky commits");
    expect(summary.markdown).toContain("failed, then passed on retry");
  });

  test("an entry that matched no test in a file that ran is flagged stale", () => {
    const summary = jobSummary({
      registry: { entries: [entry()] },
      records: [{ type: "loaded", file: FILE }],
      history: undefined,
      now: NOW,
    });
    expect(summary.annotations.at(0)).toContain("Stale flaky-test quarantine");
    expect(summary.markdown).toContain("matched no test");
    expect(summary.markdown).toContain("History unavailable.");
  });

  test("expired entries are marked but still recorded, and unloaded files are omitted", () => {
    const expired = jobSummary({
      registry: {
        entries: [entry({ created: "2026-10-01", expires: "2026-10-16" })],
      },
      records: [
        { type: "loaded", file: FILE },
        { type: "registered", id: ID },
        { type: "passed", id: ID, durationMs: 1 },
      ],
      history: undefined,
      now: NOW,
    });
    expect(expired.markdown).toContain("2026-10-16 (expired)");
    expect(expired.annotations).toEqual([]);
    expect(
      jobSummary({
        registry: { entries: [entry()] },
        records: [],
        history: undefined,
        now: NOW,
      }),
    ).toEqual({ markdown: "", annotations: [] });
  });
});

describe("evidence collection", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const artifacts = (runIds: readonly number[]) =>
    JSON.stringify([
      {
        total_count: runIds.length,
        artifacts: runIds.map((id) => ({
          expired: false,
          created_at: at(2),
          workflow_run: { id, head_sha: sha(id) },
        })),
      },
    ]);

  test("downloads only digests whose commit later passed and skips unreadable ones", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "flaky-history-"));
    roots.push(workdir);
    const downloads: string[] = [];
    const digest: FailureRecord[] = [
      {
        job: "ci-tests (rest-web)",
        step: "Test web",
        kind: "test",
        url: "",
        lines: [],
        tests: [
          {
            scope: "@stll/web",
            file: "src/widget.test.ts",
            name: "widget > renders",
          },
        ],
      },
    ];
    const gh: Gh = async (args) => {
      const [command, ...rest] = args;
      if (command === "run") {
        const name = rest.at(rest.indexOf("--name") + 1) ?? "";
        const dir = rest.at(rest.indexOf("--dir") + 1) ?? "";
        downloads.push(`${rest.at(1) ?? ""}:${name}`);
        mkdirSync(dir, { recursive: true });
        // Run 2 predates structured test identities.
        writeFileSync(
          path.join(dir, "ci-failures.json"),
          JSON.stringify(
            rest.at(1) === "1"
              ? digestFile(digest, { GITHUB_RUN_ID: "1" })
              : { version: 1, failures: [{ job: "x" }] },
          ),
        );
        return Result.ok("");
      }
      const url = rest.at(-1) ?? "";
      if (
        url.includes("/workflows/ci.yml/runs") &&
        url.includes("created=2026-10-15")
      ) {
        return Result.ok(
          JSON.stringify([
            {
              total_count: 3,
              workflow_runs: [
                {
                  id: 1,
                  head_sha: sha(1),
                  head_branch: "feature-a",
                  conclusion: "success",
                  run_started_at: at(1),
                },
                {
                  id: 2,
                  head_sha: sha(2),
                  head_branch: "feature-b",
                  conclusion: "success",
                  run_started_at: at(1),
                },
                {
                  id: 3,
                  head_sha: sha(3),
                  head_branch: "feature-c",
                  conclusion: "failure",
                  run_started_at: at(1),
                },
              ],
            },
          ]),
        );
      }
      if (url.includes("/workflows/")) {
        return Result.ok(
          JSON.stringify([{ total_count: 0, workflow_runs: [] }]),
        );
      }
      if (url.includes("/actions/runs/1/jobs?")) {
        return Result.ok(
          JSON.stringify([
            {
              jobs: [
                {
                  name: "ci-tests (rest-web)",
                  steps: [{ name: "Test web", conclusion: "success" }],
                },
              ],
            },
          ]),
        );
      }
      if (url.includes("/actions/runs/2/jobs?")) {
        return Result.ok(JSON.stringify([{ jobs: [] }]));
      }
      return Result.ok(
        url.includes("name=ci-failures") ? artifacts([1, 2, 3]) : artifacts([]),
      );
    };
    const collected = await collectEvidence({
      gh,
      repository: "stella/stella",
      now: NOW,
      workdir,
    });
    expect(collected.isOk()).toBe(true);
    if (!collected.isOk()) {
      return;
    }
    expect(downloads).toEqual([
      "1:ci-failures",
      "2:ci-failures",
      "3:ci-failures",
    ]);
    expect(collected.value.skipped).toBe(2);
    expect(
      buildHistory({ evidence: collected.value.evidence, exists })[ID],
    ).toHaveLength(1);
  });

  test("quarantine reports are listed for every ci-tests matrix job", async () => {
    const listed: string[] = [];
    const gh: Gh = async (args) => {
      const url = args.at(-1) ?? "";
      listed.push(url);
      return Result.ok(
        url.includes("/runs?")
          ? JSON.stringify([{ total_count: 0, workflow_runs: [] }])
          : artifacts([]),
      );
    };
    const collected = await collectEvidence({
      gh,
      repository: "stella/stella",
      now: NOW,
      workdir: tmpdir(),
    });
    expect(collected.isOk()).toBe(true);
    for (const shard of FULL_TEST_JOB_SHARDS) {
      expect(
        listed.some((url) =>
          url.includes(`name=${quarantineArtifactName(shard)}&`),
        ),
      ).toBe(true);
    }
  });

  test("counts workflow runs without a head branch", async () => {
    const gh: Gh = async (args) => {
      const url = args.at(-1) ?? "";
      if (
        url.includes("/workflows/ci.yml/runs?") &&
        url.includes("created=2026-10-10")
      ) {
        return Result.ok(
          JSON.stringify([
            {
              total_count: 1,
              workflow_runs: [
                {
                  id: 1,
                  head_sha: sha(1),
                  head_branch: null,
                  conclusion: "success",
                  run_started_at: at(1),
                },
              ],
            },
          ]),
        );
      }
      return Result.ok(
        url.includes("/runs?")
          ? JSON.stringify([{ total_count: 0, workflow_runs: [] }])
          : artifacts([]),
      );
    };
    const collected = await collectEvidence({
      gh,
      repository: "stella/stella",
      now: NOW,
      workdir: tmpdir(),
    });
    expect(collected.isOk()).toBe(true);
    if (!collected.isOk()) {
      return;
    }
    expect(collected.value.evidence.runs).toHaveLength(1);
    expect(collected.value.evidence.runs.at(0)?.headBranch).toBeNull();
  });

  test("a failed GitHub call is returned, not thrown", async () => {
    const gh: Gh = async () =>
      Result.err(new GhCommandError({ message: "offline" }));
    expect(
      (
        await collectEvidence({
          gh,
          repository: "stella/stella",
          now: NOW,
          workdir: tmpdir(),
        })
      ).isErr(),
    ).toBe(true);
  });

  test("refuses a truncated per-day workflow run listing", async () => {
    const gh: Gh = async (args) => {
      const url = args.at(-1) ?? "";
      if (url.includes("/runs?")) {
        return Result.ok(
          JSON.stringify([{ total_count: 2, workflow_runs: [] }]),
        );
      }
      return Result.ok(artifacts([]));
    };
    const collected = await collectEvidence({
      gh,
      repository: "stella/stella",
      now: NOW,
      workdir: tmpdir(),
    });
    expect(collected.isErr()).toBe(true);
    if (collected.isErr()) {
      expect(collected.error.message).toContain(
        "Incomplete workflow run listing for ci.yml on 2026-10-10",
      );
    }
  });

  test.each([1001, 2, 1000, 1002])(
    "checks the combined count after splitting a capped listing: %s",
    async (combinedCount) => {
      const listed: string[] = [];
      const gh: Gh = async (args) => {
        const url = args.at(-1) ?? "";
        if (url.includes("/workflows/ci.yml/runs?created=2026-10-10")) {
          listed.push(url);
          const isWholeDay = url.includes(
            "created=2026-10-10T00:00:00Z..2026-10-10T23:59:59Z",
          );
          const firstHalf = listed.length === 2;
          const halfCount = firstHalf
            ? Math.ceil(combinedCount / 2)
            : Math.floor(combinedCount / 2);
          const count = isWholeDay ? 1 : halfCount;
          const runs = Array.from({ length: count }, (_, index) => ({
            id: firstHalf
              ? index + 1
              : Math.ceil(combinedCount / 2) + index + 1,
            head_sha: "abc",
            head_branch: "feature",
            conclusion: "success",
            run_started_at: firstHalf
              ? "2026-10-10T08:00:00Z"
              : "2026-10-10T20:00:00Z",
          }));
          return Result.ok(
            JSON.stringify([
              { total_count: isWholeDay ? 1001 : count, workflow_runs: runs },
            ]),
          );
        }
        if (url.includes("/runs?")) {
          return Result.ok(
            JSON.stringify([{ total_count: 0, workflow_runs: [] }]),
          );
        }
        return Result.ok(artifacts([]));
      };
      const collected = await collectEvidence({
        gh,
        repository: "stella/stella",
        now: NOW,
        workdir: tmpdir(),
      });
      expect(collected.isOk()).toBe(combinedCount === 1001);
      if (collected.isErr()) {
        expect(collected.error.message).toContain(
          `GitHub reported 1001, but returned ${combinedCount}`,
        );
      } else {
        expect(collected.value.evidence.runs).toHaveLength(1001);
      }
      expect(listed).toEqual([
        expect.stringContaining(
          "created=2026-10-10T00:00:00Z..2026-10-10T23:59:59Z",
        ),
        expect.stringContaining(
          "created=2026-10-10T00:00:00Z..2026-10-10T11:59:59Z",
        ),
        expect.stringContaining(
          "created=2026-10-10T12:00:00Z..2026-10-10T23:59:59Z",
        ),
      ]);
    },
  );

  test("refuses a truncated artifact listing", async () => {
    const gh: Gh = async (args) => {
      const url = args.at(-1) ?? "";
      if (url.includes("/runs?")) {
        return Result.ok(
          JSON.stringify([{ total_count: 0, workflow_runs: [] }]),
        );
      }
      return Result.ok(JSON.stringify([{ total_count: 1, artifacts: [] }]));
    };
    const collected = await collectEvidence({
      gh,
      repository: "stella/stella",
      now: NOW,
      workdir: tmpdir(),
    });
    expect(collected.isErr()).toBe(true);
    if (collected.isErr()) {
      expect(collected.error.message).toContain(
        "Incomplete artifact listing for ci-failures",
      );
    }
  });

  test("the latest published history is read from its artifact", async () => {
    const workdir = mkdtempSync(path.join(tmpdir(), "flaky-history-"));
    roots.push(workdir);
    const history = {
      generatedAt: NOW.toISOString(),
      tests: { [ID]: [retryPass(1)] },
      flakyChecks: [],
    };
    const gh: Gh = async (args) => {
      if (args.at(0) === "run") {
        const dir = args.at(args.indexOf("--dir") + 1) ?? "";
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify(history));
        return Result.ok("");
      }
      expect(args.at(-1)).toContain(`name=${HISTORY_ARTIFACT}`);
      return Result.ok(
        JSON.stringify({
          artifacts: [{ expired: false, workflow_run: { id: 7 } }],
        }),
      );
    };
    const fetched = await fetchLatestHistory({
      gh,
      repository: "stella/stella",
      workdir,
    });
    expect(fetched.isOk() ? fetched.value : undefined).toEqual(history);
  });
});

describe("check flakes", () => {
  const source = {
    createdAt: at(2),
    url: "https://github.com/stella/stella/actions/runs/1",
    tests: [],
    headSha: sha(1),
    checks: [{ job: "ci-checks (ubuntu)", step: "Typecheck" }],
  };

  test("a successful run that skipped the failed step is not flaky", () => {
    expect(
      findFlakyChecks(
        evidence({
          digests: [source],
          runs: [
            {
              headSha: sha(1),
              conclusion: "success",
              startedAt: at(1),
              successfulChecks: [
                { job: "ci-checks (ubuntu)", step: "Checkout" },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("a successful receipt for the same job and step is flaky", () => {
    const runSource = {
      createdAt: at(2),
      url: "https://github.com/stella/stella/actions/runs/1",
      tests: [],
    };
    expect(
      findFlakyChecks(
        evidence({
          digests: [
            {
              ...runSource,
              headSha: sha(1),
              checks: [
                { job: "ci-checks", step: "Typecheck" },
                { job: "ci-result", step: "Aggregate" },
              ],
            },
            {
              ...runSource,
              headSha: sha(2),
              checks: [{ job: "lint", step: "Lint" }],
            },
          ],
          runs: [
            {
              headSha: sha(1),
              conclusion: "success",
              startedAt: at(1),
              successfulChecks: [
                { job: "ci-checks (macos)", step: "Typecheck" },
              ],
            },
            {
              headSha: sha(3),
              conclusion: "success",
              startedAt: at(1),
              successfulChecks: [],
            },
          ],
        }),
      ),
    ).toEqual([
      {
        job: "ci-checks",
        step: "Typecheck",
        flakyFailures: 1,
        commits: 1,
        lastSeen: at(2),
      },
    ]);
  });
});

describe("CODEOWNERS proposals", () => {
  const candidates = [
    {
      id: ID,
      commits: [sha(1)],
      evidenceKind: "same-commit" as const,
      branches: 0,
      observations: [retryPass(1)],
    },
  ];

  test("last matching pattern wins, including directory patterns", () => {
    const owners = resolveOwners(
      "*.test.ts @broad\napps/web/ @directory\n/apps/web/src/widget.test.ts @specific\n",
      [FILE],
    );
    expect(owners.get(FILE)).toBe("specific");
    expect(resolveOwners("apps/web/ @directory\n", [FILE]).get(FILE)).toBe(
      "directory",
    );
  });

  test("patterns anchor and cover directories as GitHub's CODEOWNERS does", () => {
    const paths = [
      "scripts/a.test.ts",
      "packages/scripts/src/b.test.ts",
      "apps/api/src/c.test.ts",
      "package.json",
      "apps/web/package.json",
    ];
    const owned = (content: string) =>
      [...resolveOwners(content, paths).keys()].toSorted();
    // An unanchored directory pattern matches that directory at any depth.
    expect(owned("scripts/ @s\n")).toEqual([
      "packages/scripts/src/b.test.ts",
      "scripts/a.test.ts",
    ]);
    // A rooted path without a trailing slash also covers a directory's contents.
    expect(owned("/apps/api @api\n")).toEqual(["apps/api/src/c.test.ts"]);
    // A leading slash anchors a file to the root; without one it matches anywhere.
    expect(owned("/package.json @root\n")).toEqual(["package.json"]);
    expect(owned("package.json @any\n")).toEqual([
      "apps/web/package.json",
      "package.json",
    ]);
    // An inner slash anchors the pattern too.
    expect(owned("src/c.test.ts @inner\n")).toEqual([]);
  });

  test("an unmatched test needs an owner and gets no entry", () => {
    const proposal = proposeQuarantine({
      registry: empty,
      candidates,
      owners: resolveOwners("scripts/ @scripts\n", [FILE]),
      now: NOW,
    });
    expect(proposal.added).toEqual([]);
    expect(proposal.unowned).toEqual(candidates);
    expect(
      proposalBody({
        proposal,
        tests: { [ID]: [retryPass(1)] },
        flakyChecks: [],
      }),
    ).toContain("## Needs an owner");
  });

  test("a team-owned rule produces a valid canonical proposal", () => {
    const proposal = proposeQuarantine({
      registry: empty,
      candidates,
      owners: resolveOwners("apps/web/ @stella/quality-team\n", [FILE]),
      now: NOW,
    });
    expect(proposal.added.at(0)?.owner).toBe("stella/quality-team");
    const serialized = serializeRegistry(proposal.registry);
    expect(parseRegistry(JSON.parse(serialized))).toMatchObject({
      status: "valid",
    });
    expect(serialized).toBe(serializeRegistry(proposal.registry));
  });
});

test("the job summary reports an unreadable record as a warning and never fails the job", () => {
  const reports = mkdtempSync(path.join(tmpdir(), "flaky-test-report-"));
  try {
    // A test process killed mid-write leaves a truncated line.
    writeFileSync(
      path.join(reports, "1-killed.jsonl"),
      '{"type":"failed","id":',
    );
    const run = Bun.spawnSync(
      [
        process.execPath,
        "scripts/flaky-test-history.ts",
        "job-summary",
        "--reports",
        reports,
      ],
      { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain(
      "::warning title=Quarantine report unavailable::",
    );
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
});
