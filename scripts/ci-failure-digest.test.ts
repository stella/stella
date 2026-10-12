import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  annotations,
  buildDigest,
  classify,
  dedupe,
  escapeMarkdown,
  failureLines,
  findLocation,
  frameLocation,
  inert,
  isFailedJob,
  MAX_ANNOTATIONS,
  MAX_LINE_WIDTH,
  MAX_LINES_PER_STEP,
  MAX_SCAN_WIDTH,
  parseJobs,
  playwrightEntry,
  renderTail,
  segmentForStep,
  splitSteps,
  stripAnsi,
  summaryMarkdown,
  testFailures,
  type FailureRecord,
} from "./ci-failure-digest";

const ROOT = path.resolve(import.meta.dir, "..");
const WORK = "/home/runner/work/stella/stella";

// Prefixes each line with a runner timestamp `seconds` past 10:00:00.
const stamp = (seconds: number, lines: readonly string[]): string[] =>
  lines.map(
    (line) =>
      `2026-10-12T10:00:${String(seconds).padStart(2, "0")}.1234567Z ${line}`,
  );

const runStep = (seconds: number, command: string, body: readonly string[]) =>
  stamp(seconds, [
    `##[group]Run ${command}`,
    command,
    "shell: /usr/bin/bash -e {0}",
    "##[endgroup]",
    ...body,
  ]);

const BUN_FAILURE = [
  "@stll/api:test: src/math.test.ts:",
  "@stll/api:test: (pass) math > subtracts [0.10ms]",
  "@stll/web:test: (pass) web > renders [0.20ms]",
  "@stll/api:test: 12 |     expect(add(1, 1)).toBe(3);",
  "@stll/api:test:                           ^",
  "@stll/api:test: error: expect(received).toBe(expected)",
  "@stll/api:test:",
  "@stll/api:test: Expected: 3",
  "@stll/api:test: Received: 2",
  "@stll/api:test:",
  `@stll/api:test:       at <anonymous> (${WORK}/apps/api/src/math.test.ts:12:27)`,
  "@stll/api:test: (fail) math > adds [0.30ms]",
  "@stll/web:test: (pass) web > hydrates [0.20ms]",
  "@stll/api:test:",
  "@stll/api:test: 1 tests failed:",
  "@stll/api:test: (fail) math > adds [0.30ms]",
  "@stll/api:test:  1 pass",
  "@stll/api:test:  1 fail",
];

const RATCHET_FAILURE = [
  "(pass) ratchet improvements > counts [1.00ms]",
  "ratchet timing: head 100ms; base export + scan 200ms (origin/main)",
  "ratchet: lint-suppressions dropped 4 -> 3.",
  "",
  "ratchet --check: invalid increase allowances:",
  "",
  "  as-casts: 10 -> 11 (+1)",
  "      apps/api/src/x.ts: 2 -> 3",
  "",
  "Increases relative to the measured base tree require exact, justified allowances added in this PR.",
  "##[error]Process completed with exit code 1.",
];

test("ANSI escapes and long lines are removed and bounded", () => {
  expect(stripAnsi("\u001B[31merror\u001B[0m: \u001B[1mboom\u001B[22m")).toBe(
    "error: boom",
  );
  const [line] = failureLines([`##[error]${"x".repeat(500)}`]);
  expect(line?.message.length).toBe(MAX_LINE_WIDTH);
  expect(line?.message.endsWith("...")).toBe(true);
});

test("bun test failures keep their error and repository location", () => {
  const failures = testFailures(BUN_FAILURE);
  // The closing "tests failed" list repeats the failure without detail.
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    scope: "@stll/api",
    name: "math > adds",
    file: "apps/api/src/math.test.ts",
    line: 12,
  });
  expect(failures[0]?.detail).toContain("Received: 2");
  expect(failures[0]?.detail.join("\n")).not.toContain("(pass)");
  expect(failureLines(BUN_FAILURE)).toEqual([
    {
      message:
        "@stll/api: (fail) math > adds (apps/api/src/math.test.ts:12) -- error: expect(received).toBe(expected)",
      file: "apps/api/src/math.test.ts",
      line: 12,
    },
  ]);
});

test("a test run's tail lists only the failures, after everything else", () => {
  const tail = renderTail(BUN_FAILURE);
  expect(tail.split("\n").at(0)).toBe("---- failing tests (1 of 1) ----");
  expect(tail).toContain(
    "@stll/api: (fail) math > adds (apps/api/src/math.test.ts:12)",
  );
  expect(tail).toContain("    Expected: 3");
  expect(tail).not.toContain("(pass)");
  expect(renderTail(["(pass) a [1ms]", " 1 pass"])).toBe("");
});

test("typecheck diagnostics in tsc and tsgo formats carry file and line", () => {
  expect(
    failureLines([
      "@stll/web:typecheck: src/routes/a.tsx(41,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      `${WORK}/apps/api/src/b.ts:9:3 - error TS2304: Cannot find name 'x'.`,
      "@stll/web:typecheck: ERROR: command finished with error",
    ]),
  ).toEqual([
    {
      message:
        "@stll/web: src/routes/a.tsx:41 TS2322: Type 'string' is not assignable to type 'number'.",
    },
    {
      message: "apps/api/src/b.ts:9 TS2304: Cannot find name 'x'.",
      file: "apps/api/src/b.ts",
      line: 9,
    },
  ]);
});

test("oxlint diagnostics take the location from their source frame", () => {
  expect(
    failureLines([
      "  ! eslint(no-console): Unexpected console statement.",
      "   ,-[apps/web/src/warn.ts:1:1]",
      "  x eslint(no-unused-vars): Variable 'x' is declared but never used.",
      "   ,-[apps/web/src/x.ts:3:7]",
      "  × typescript(no-explicit-any): Unexpected any.",
      "   ╭─[packages/ui/src/y.tsx:8:12]",
    ]),
  ).toEqual([
    {
      message:
        "apps/web/src/x.ts:3 eslint(no-unused-vars): Variable 'x' is declared but never used.",
      file: "apps/web/src/x.ts",
      line: 3,
    },
    {
      message:
        "packages/ui/src/y.tsx:8 typescript(no-explicit-any): Unexpected any.",
      file: "packages/ui/src/y.tsx",
      line: 8,
    },
  ]);
});

test("Playwright failures are read from the list reporter's summary", () => {
  const lines = failureLines([
    "  ✓  1 [chromium] › e2e/home.spec.ts:5:3 › home › loads (1.2s)",
    "  1) [chromium] › e2e/login.spec.ts:14:3 › login › rejects a wrong password ─────",
    "",
    "    Error: expect(locator).toBeVisible() failed",
    "",
    "    Locator: getByText('Wrong password')",
    "  1 failed",
  ]);
  expect(lines).toEqual([
    {
      message:
        "(fail) [chromium] login › rejects a wrong password (e2e/login.spec.ts:14) -- Error: expect(locator).toBeVisible() failed",
    },
  ]);
});

test("a guard's verdict above the exit is the digest, not earlier output", () => {
  const lines = failureLines(RATCHET_FAILURE);
  expect(lines.map(({ message }) => message)).toEqual([
    "ratchet --check: invalid increase allowances:",
    "as-casts: 10 -> 11 (+1)",
    "apps/api/src/x.ts: 2 -> 3",
    "Increases relative to the measured base tree require exact, justified allowances added in this PR.",
  ]);
  expect(classify("Ratchet guard", lines)).toBe("ratchet");
});

test("a step's own error command anchors its closing lines", () => {
  expect(
    failureLines([
      "Checking 120 files",
      "expected layout found",
      "##[error]docs/a.md:4 links to a missing page",
      "##[error]Process completed with exit code 1.",
    ]),
  ).toEqual([
    {
      message: "docs/a.md:4 links to a missing page",
      file: "docs/a.md",
      line: 4,
    },
  ]);
});

test("at most the first lines are kept, deduplicated", () => {
  const repeated = Array.from(
    { length: 12 },
    (_, index) => `src/a.ts(${(index % 3) + 1},1): error TS2322: Bad.`,
  );
  const lines = failureLines(repeated);
  expect(lines).toHaveLength(3);
  expect(
    dedupe([{ message: "a" }, { message: "a" }, { message: "a", line: 1 }]),
  ).toHaveLength(2);
  const many = Array.from(
    { length: 12 },
    (_, index) => `src/a.ts(${index + 1},1): error TS2322: Bad.`,
  );
  expect(failureLines(many)).toHaveLength(MAX_LINES_PER_STEP);
});

test("step kinds follow the step name, then the extracted lines", () => {
  expect(classify("Test API or rest", [])).toBe("test");
  expect(classify("Typecheck affected packages", [])).toBe("typecheck");
  expect(classify("Run", [{ message: "a.ts:1 TS2322: Bad." }])).toBe(
    "typecheck",
  );
  expect(classify("Lint changed files", [])).toBe("lint");
  expect(classify("Build web", [])).toBe("build");
  expect(classify("Check generated sources are current", [])).toBe("policy");
  expect(classify("Run", [{ message: "x" }])).toBe("other");
});

const JOB_LOG = [
  ...stamp(1, ["Current runner version: '2.330.0'"]),
  ...runStep(2, "bun scripts/typecheck-negative.ts", [
    // A deliberate negative test: prints an error command and passes.
    "##[error]src/fixture.ts(1,1): error TS2322: Deliberate fixture error.",
    "Typecheck command rejects errors: ok",
  ]),
  ...runStep(4, "bun scripts/ratchet.ts --check", RATCHET_FAILURE),
  ...stamp(9, ["Post job cleanup.", "##[error]Cleanup noise after the step"]),
].join("\n");

const JOBS = [
  {
    total_count: 3,
    jobs: [
      {
        id: 11,
        name: "ci-checks-policy",
        conclusion: "failure",
        html_url: "https://github.com/o/r/actions/runs/1/job/11",
        steps: [
          {
            name: "Set up job",
            number: 1,
            conclusion: "success",
            started_at: "2026-10-12T10:00:00Z",
            completed_at: "2026-10-12T10:00:01Z",
          },
          {
            name: "Typecheck command rejects errors",
            number: 2,
            conclusion: "success",
            started_at: "2026-10-12T10:00:02Z",
            completed_at: "2026-10-12T10:00:03Z",
          },
          {
            name: "Ratchet guard",
            number: 3,
            conclusion: "failure",
            started_at: "2026-10-12T10:00:04Z",
            completed_at: "2026-10-12T10:00:08Z",
          },
        ],
      },
      {
        id: 12,
        name: "ci-tests (api-1)",
        conclusion: "success",
        steps: [],
      },
    ],
  },
  {
    jobs: [
      {
        id: 13,
        name: "web-build",
        conclusion: "failure",
        html_url: "https://github.com/o/r/actions/runs/1/job/13",
        steps: [
          {
            name: "Build web",
            number: 4,
            conclusion: "failure",
            started_at: "2026-10-12T10:00:02Z",
            completed_at: "2026-10-12T10:00:03Z",
          },
        ],
      },
    ],
  },
];

test("only steps that failed are digested; negative tests that pass are not", () => {
  const records = buildDigest({
    jobs: parseJobs(JOBS),
    logFor: ({ id }) => (id === 11 ? JOB_LOG : undefined),
  });
  expect(records.map(({ job, step, kind }) => [job, step, kind])).toEqual([
    ["ci-checks-policy", "Ratchet guard", "ratchet"],
    ["web-build", "Build web", "build"],
  ]);
  const text = JSON.stringify(records);
  expect(text).not.toContain("Deliberate fixture error");
  expect(text).not.toContain("Cleanup noise");
  expect(records[0]?.lines.at(0)?.message).toBe(
    "ratchet --check: invalid increase allowances:",
  );
  expect(records[1]?.lines).toEqual([
    {
      message:
        'Log of job "web-build" was unavailable to the digest. See https://github.com/o/r/actions/runs/1/job/13',
    },
  ]);
});

test("log steps split at their run groups and end at the runner's exit line", () => {
  const segments = splitSteps(JOB_LOG);
  expect(segments.map(({ failed }) => failed)).toEqual([
    false,
    false,
    true,
    false,
  ]);
  expect(segments[1]?.lines.join("\n")).not.toContain("shell: /usr/bin/bash");
  expect(segments[2]?.startedAt).toBe(Date.parse("2026-10-12T10:00:04.123Z"));
});

const record = (index: number): FailureRecord => ({
  job: `job, ${index}`,
  step: "Step: one",
  kind: "test",
  url: "",
  lines: [
    { message: "100% broken\nsecond", file: "apps/a,b.ts", line: index + 1 },
  ],
});

test("annotations escape workflow command syntax and respect the step cap", () => {
  const [first] = annotations([record(0)]);
  expect(first).toBe(
    "::error file=apps/a%2Cb.ts,line=1,title=job%2C 0 / Step%3A one [test]::100%25 broken%0Asecond",
  );
  const capped = annotations(
    Array.from({ length: MAX_ANNOTATIONS + 3 }, (_, index) => record(index)),
  );
  expect(capped).toHaveLength(MAX_ANNOTATIONS);
  expect(capped.at(-1)).toStartWith("::error title=4 more failed steps::");
  for (const command of capped) {
    expect(command.split("\n")).toHaveLength(1);
  }
});

test("the summary names each failed step with its lines", () => {
  const summary = summaryMarkdown([
    { ...record(0), url: "https://example.test/job/1" },
  ]);
  expect(summary).toContain(
    "**job, 0 / Step: one** `test` ([log](https://example.test/job/1))",
  );
  expect(summaryMarkdown([])).toContain("No failed step");
});

test("summary names render literally", () => {
  expect(escapeMarkdown("a_b *c* [d](e) <f> #1 `g` |")).toBe(
    "a\\_b \\*c\\* \\[d\\](e) \\<f\\> \\#1 \\`g\\` \\|",
  );
  expect(
    summaryMarkdown([{ ...record(0), job: "build_web", step: "Run **x**" }]),
  ).toContain("**build\\_web / Run \\*\\*x\\*\\***");
});

test("an oversized log line costs bounded time", () => {
  const huge = `${"a/".repeat(25_000)}${"b.".repeat(25_000)}`;
  expect(huge.length).toBe(100_000);
  const lines = [huge, `error ${huge}:`, `  at ${huge}`, `  1) [x] › ${huge}`];
  const started = performance.now();
  failureLines(lines);
  renderTail(lines);
  splitSteps(lines.join("\n"));
  expect(findLocation(huge)).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(MAX_SCAN_WIDTH).toBeLessThanOrEqual(2000);
});

test("locations are found per token in each supported shape", () => {
  expect(findLocation("see (apps/a.ts:12:3) now")).toEqual({
    path: "apps/a.ts",
    line: "12",
  });
  expect(findLocation("src/b.tsx(4,2): error")).toEqual({
    path: "src/b.tsx",
    line: "4",
  });
  expect(findLocation("C:\\work\\c.rs:9 failed")).toEqual({
    path: "C:\\work\\c.rs",
    line: "9",
  });
  expect(findLocation("apps/a.ts: 2 -> 3")).toBeUndefined();
  expect(frameLocation("  at fn (/w/r/r/apps/x.ts:3:4)")).toEqual({
    path: "/w/r/r/apps/x.ts",
    line: "3",
  });
  expect(frameLocation("  at C:\\r\\x.ts:3:4")).toEqual({
    path: "C:\\r\\x.ts",
    line: "3",
  });
  expect(frameLocation("  at native")).toBeUndefined();
  expect(
    playwrightEntry(
      "  ✘  3 [webkit] › e2e/a.spec.ts:7:1 › suite › title (2.5s)",
    ),
  ).toEqual({
    project: "webkit",
    path: "e2e/a.spec.ts",
    line: "7",
    title: "suite › title",
  });
});

test("echoed log text never forms a workflow command", () => {
  const hostile = [
    "@stll/api:test: ::error::spoofed",
    "@stll/api:test:   ::set-output name=x::y",
    "@stll/api:test: ##[error]spoofed too",
    "@stll/api:test: (fail) ::warning::name",
  ];
  for (const tail of [
    renderTail(hostile),
    renderTail(["::error file=x::failed here"]),
  ]) {
    expect(tail).not.toBe("");
    for (const line of tail.split("\n")) {
      expect(line.trimStart().startsWith("::"), line).toBe(false);
      expect(line.trimStart().startsWith("##["), line).toBe(false);
    }
  }
  expect(inert("  ::error::x")).toBe("|   ::error::x");
  expect(inert("plain")).toBe("plain");
});

test("a failed step maps to the segment starting closest to it", () => {
  const log = [
    ...runStep(4, "first", [
      "boom one",
      "##[error]Process completed with exit code 1.",
    ]),
    ...runStep(5, "second", [
      "boom two",
      "##[error]Process completed with exit code 2.",
    ]),
  ].join("\n");
  const segments = splitSteps(log);
  const step = {
    name: "second",
    number: 2,
    conclusion: "failure",
    started_at: "2026-10-12T10:00:05Z",
    completed_at: "2026-10-12T10:00:05Z",
  };
  expect(segmentForStep(step, segments)?.lines.join("\n")).toContain(
    "boom two",
  );
});

const GATED_JOBS = [
  {
    jobs: [
      { id: 1, name: "timed out", conclusion: "timed_out", steps: [] },
      {
        id: 2,
        name: "cancelled after a failure",
        conclusion: "cancelled",
        steps: [{ name: "Check", number: 3, conclusion: "failure" }],
      },
      {
        id: 3,
        name: "superseded",
        conclusion: "cancelled",
        steps: [{ name: "Check", number: 3, conclusion: "cancelled" }],
      },
      { id: 4, name: "passed", conclusion: "success", steps: [] },
    ],
  },
];

test("timed-out jobs and cancelled jobs with a failed step are digested", () => {
  const jobs = parseJobs(GATED_JOBS);
  expect(jobs.filter(isFailedJob).map(({ id }) => id)).toEqual([1, 2]);
  const records = buildDigest({ jobs, logFor: () => undefined });
  expect(records.map(({ job, step }) => [job, step])).toEqual([
    ["timed out", "(job)"],
    ["cancelled after a failure", "Check"],
  ]);
});

// Stands in for scripts/gh-retry.sh: job 1's log is served at once, job 2's
// only from the second request (not ready yet), job 7's never.
const FAKE_GH_RETRY = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "$FAKE_CALLS"',
  "for endpoint; do :; done",
  'id=$(basename "$(dirname "$endpoint")")',
  'count=$(( $(cat "$FAKE_STATE/$id" 2>/dev/null || echo 0) + 1 ))',
  'echo "$count" > "$FAKE_STATE/$id"',
  'case "$id" in',
  '  1) printf "log one\\n" ;;',
  '  2) if ((count < 2)); then exit 1; fi; printf "log two\\n" ;;',
  "  *) exit 1 ;;",
  "esac",
].join("\n");

const fetchLogs = (jobs: unknown) => {
  const directory = mkdtempSync(path.join(tmpdir(), "fetch-job-logs-"));
  const state = path.join(directory, "state");
  writeFileSync(path.join(directory, "gh-retry.sh"), FAKE_GH_RETRY);
  writeFileSync(path.join(directory, "jobs.json"), JSON.stringify(jobs));
  Bun.spawnSync(["mkdir", "-p", state]);
  const result = Bun.spawnSync(
    [
      "bash",
      path.join(ROOT, "scripts/fetch-failed-job-logs.sh"),
      "o/r",
      path.join(directory, "jobs.json"),
      path.join(directory, "logs"),
      "3",
      "0",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "",
        GH_RETRY_SCRIPT: path.join(directory, "gh-retry.sh"),
        FAKE_CALLS: path.join(directory, "calls"),
        FAKE_STATE: state,
      },
    },
  );
  const read = (name: string): string | undefined => {
    const file = path.join(directory, name);
    return existsSync(file) ? readFileSync(file, "utf-8") : undefined;
  };
  return { directory, result, read };
};

test("job logs are fetched for exactly the digested jobs, retrying until served", () => {
  const { directory, result, read } = fetchLogs(GATED_JOBS);
  try {
    expect(result.exitCode).toBe(0);
    expect(read("logs/1.log")).toBe("log one\n");
    // Not served on the first request: fetched on the second.
    expect(read("logs/2.log")).toBe("log two\n");
    expect(result.stdout.toString()).toContain(
      "Log of job 2 not available yet (attempt 1/3)",
    );
    const calls = (read("calls") ?? "").trim().split("\n");
    expect(calls).toEqual([
      "api --allow-escape-sequences repos/o/r/actions/jobs/1/logs",
      "api --allow-escape-sequences repos/o/r/actions/jobs/2/logs",
      "api --allow-escape-sequences repos/o/r/actions/jobs/2/logs",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a log that is never served is bounded and named in the digest", () => {
  const jobs = [
    {
      jobs: [
        {
          id: 7,
          name: "slow job",
          conclusion: "failure",
          html_url: "https://example.test/job/7",
          steps: [{ name: "Build web", number: 2, conclusion: "failure" }],
        },
      ],
    },
  ];
  const { directory, result, read } = fetchLogs(jobs);
  try {
    expect(result.exitCode).toBe(0);
    expect(read("logs/7.log")).toBeUndefined();
    expect((read("calls") ?? "").trim().split("\n")).toHaveLength(3);
    expect(result.stdout.toString()).toContain(
      "Log of job 7 unavailable after 3 attempts.",
    );
    const [digested] = buildDigest({
      jobs: parseJobs(jobs),
      logFor: () => undefined,
    });
    expect(digested?.lines).toEqual([
      {
        message:
          'Log of job "slow job" was unavailable to the digest. See https://example.test/job/7',
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Shapes from a real failing run: a guard that panics after a catalog
// check, a lint rule id, background steps and their wait step.
const REAL_JOB_LOG = [
  ...runStep(5, "bun scripts/generated-files-guard.ts --guard-b", []),
  ...runStep(6, "bash scripts/pull-base-images.test.sh", [
    "Running pull-base-images.sh tests...",
    "  PASS  fails on an ARG with no default",
    "scripts/retry.sh:15: uncataloged env RETRY_FAILURE_LEVEL",
    'error: script "env:check" exited with code 1',
    "Panic: Generator check failed: env-examples",
    "      at guardB (/home/runner/work/stella/stella/scripts/generated-files-guard.ts:218:7)",
    "##[error]",
    "      at guardB (/home/runner/work/stella/stella/scripts/generated-files-guard.ts:218:7)",
    "Bun v1.4.3 (Linux x64)",
    "##[error]Process completed with exit code 1.",
    "  PASS  every repository Dockerfile resolves in buildx mode",
  ]),
  ...runStep(8, "bash scripts/check-bridge-version.sh", [
    "No bridge-surface changes detected since origin/main. OK.",
  ]),
  ...stamp(8, [
    "Waiting for all background step(s) to complete: Generated files manifest guard",
    "Finished waiting for all background step(s).",
    "  Generated files manifest guard: Failed",
    "Post job cleanup.",
    "[command]/usr/bin/git version",
  ]),
].join("\n");

test("a real run's guard, lint and wait-step failures digest to their causes", () => {
  const steps = [
    ["Generated files manifest guard", "10:00:05Z", "10:00:07Z"],
    ["Wait for independent repository checks", "10:00:08Z", "10:00:08Z"],
  ].map(([name, started, completed], index) => ({
    name,
    number: index + 1,
    conclusion: "failure",
    started_at: `2026-10-12T${started}`,
    completed_at: `2026-10-12T${completed}`,
  }));
  const records = buildDigest({
    jobs: [{ id: 1, name: "ci-checks-rest", conclusion: "failure", steps }],
    logFor: () => REAL_JOB_LOG,
  });
  expect(records.map(({ lines }) => lines)).toEqual([
    [
      {
        message: "scripts/retry.sh:15: uncataloged env RETRY_FAILURE_LEVEL",
        file: "scripts/retry.sh",
        line: 15,
      },
    ],
    [{ message: "Generated files manifest guard: Failed" }],
  ]);
  expect(
    classify("Code quality (rest)", [
      { message: "typescript(no-base-to-string): a.ts:1:2: bad" },
    ]),
  ).toBe("lint");
  expect(
    testFailures([
      "@stll/docx-utils test:office-fixture-metadata: (fail) a > b [1ms]",
    ]).map(({ scope }) => scope),
  ).toEqual(["@stll/docx-utils"]);
});

test("a retry summary never hides the error output above it", () => {
  expect(
    failureLines([
      "Resolving dependencies",
      "error: failed to download package left-pad@1.0.0",
      "retry.sh: attempt 1/2 failed (exit 1); retrying in 15s: bun ci",
      "error: failed to download package left-pad@1.0.0",
      "##[error]bun ci failed after 2 attempts (exit 1)",
      "##[error]Process completed with exit code 1.",
    ]).map(({ message }) => message),
  ).toEqual([
    "error: failed to download package left-pad@1.0.0",
    "bun ci failed after 2 attempts (exit 1)",
  ]);
});

test("each log segment explains at most one failed step", () => {
  const log = [
    ...runStep(4, "first", [
      "boom one",
      "##[error]Process completed with exit code 1.",
    ]),
    ...runStep(4, "second", [
      "boom two",
      "##[error]Process completed with exit code 2.",
    ]),
  ].join("\n");
  const job = {
    id: 9,
    name: "job",
    conclusion: "failure",
    steps: ["first", "second"].map((name, index) => ({
      name,
      number: index + 1,
      conclusion: "failure",
      started_at: "2026-10-12T10:00:04Z",
      completed_at: "2026-10-12T10:00:04Z",
    })),
  };
  const records = buildDigest({ jobs: [job], logFor: () => log });
  const messages = records.map(({ lines }) =>
    lines.map(({ message }) => message).join(","),
  );
  expect(new Set(messages).size).toBe(2);
  expect(messages.join(",")).toContain("boom one");
  expect(messages.join(",")).toContain("boom two");
});

test("the digest command writes JSON, a summary and annotations", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-failure-digest-"));
  try {
    writeFileSync(path.join(directory, "jobs.json"), JSON.stringify(JOBS));
    writeFileSync(path.join(directory, "11.log"), JOB_LOG);
    writeFileSync(path.join(directory, "summary.md"), "");
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(ROOT, "scripts/ci-failure-digest.ts"),
        "digest",
        "--jobs",
        path.join(directory, "jobs.json"),
        "--logs",
        directory,
        "--json",
        path.join(directory, "ci-failures.json"),
        "--summary",
        path.join(directory, "summary.md"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString().trim().split("\n");
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toStartWith(
      "::error title=ci-checks-policy / Ratchet guard [ratchet]::",
    );
    const digest: unknown = JSON.parse(
      readFileSync(path.join(directory, "ci-failures.json"), "utf-8"),
    );
    expect(digest).toMatchObject({
      version: 1,
      failures: [{ step: "Ratchet guard" }, { step: "Build web" }],
    });
    expect(readFileSync(path.join(directory, "summary.md"), "utf-8")).toContain(
      "### Failure digest",
    );

    writeFileSync(path.join(directory, "test.log"), BUN_FAILURE.join("\n"));
    const tail = Bun.spawnSync(
      [
        process.execPath,
        path.join(ROOT, "scripts/ci-failure-digest.ts"),
        "tail",
        path.join(directory, "test.log"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(tail.exitCode).toBe(0);
    expect(tail.stdout.toString()).toContain("(fail) math > adds");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

type WorkflowStep = {
  name?: string;
  if?: string;
  "timeout-minutes"?: number;
  run?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
};
type Workflow = {
  env?: Record<string, string>;
  jobs: Record<string, { steps?: WorkflowStep[] }>;
};

const isWorkflow = (value: unknown): value is Workflow =>
  typeof value === "object" &&
  value !== null &&
  "jobs" in value &&
  typeof value.jobs === "object" &&
  value.jobs !== null;

const ciWorkflow = (): Workflow => {
  const parsed: unknown = Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8"),
  );
  if (!isWorkflow(parsed)) {
    throw new TypeError("ci.yml has no jobs");
  }
  return parsed;
};

test("CI logs are plain text and failures are digested by the result gate", () => {
  const workflow = ciWorkflow();
  expect(workflow.env?.["FORCE_COLOR"]).toBe("0");
  // Node warns on stderr when NO_COLOR is set beside FORCE_COLOR.
  expect(workflow.env?.["NO_COLOR"]).toBeUndefined();

  const steps = workflow.jobs["ci-result"]?.steps ?? [];
  const tooling = steps.find(({ with: options }) =>
    String(options?.["path"] ?? "").includes(".workflow-tooling"),
  );
  expect(String(tooling?.with?.["sparse-checkout"])).toContain(
    "scripts/ci-failure-digest.ts",
  );
  const digest = steps.find(({ name }) => name === "Digest failed steps");
  expect(digest?.if).toContain("failure()");
  expect(digest?.["timeout-minutes"]).toBe(5);
  expect(digest?.run).toContain(
    "bun .workflow-tooling/scripts/ci-failure-digest.ts digest",
  );
  expect(digest?.run).toContain(
    'bash .workflow-tooling/scripts/fetch-failed-job-logs.sh "$REPO"',
  );
  expect(String(tooling?.with?.["sparse-checkout"])).toContain(
    "scripts/fetch-failed-job-logs.sh",
  );
  // The digest reports; the verdict stays with the evaluation step.
  const names = steps.map(({ name }) => name);
  expect(names.indexOf("Digest failed steps")).toBeGreaterThan(
    names.indexOf("Evaluate CI outcome"),
  );
  const upload = steps.find(({ name }) => name === "Upload failure digest");
  expect(upload?.with?.["name"]).toBe("ci-failures");

  const testSteps = (workflow.jobs["ci-tests"]?.steps ?? []).filter(
    ({ run }) => run?.includes("bun run test --") === true,
  );
  expect(testSteps.length).toBeGreaterThan(0);
  for (const step of testSteps) {
    expect(step.run, step.name).toContain(
      'timeout 60 bun scripts/ci-failure-digest.ts tail "$output" || true',
    );
  }
});

/** The ci-tests wrapper block, from the test command to its closing brace. */
const wrapperBlock = (run: string): string => {
  const lines = run.split("\n");
  const start = lines.findIndex((line) =>
    line.includes('| tee "$output" || {'),
  );
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === "}",
  );
  if (start === -1 || end === -1) {
    throw new TypeError("ci-tests test step has no failure wrapper");
  }
  return lines.slice(start, end + 1).join("\n");
};

test("a failing test run keeps its exit status through tee and the tail", () => {
  const step = (ciWorkflow().jobs["ci-tests"]?.steps ?? []).find(
    ({ run }) => run?.includes('| tee "$output" || {') === true,
  );
  const block = wrapperBlock(step?.run ?? "");
  const directory = mkdtempSync(path.join(tmpdir(), "ci-tests-wrapper-"));
  try {
    for (const [producerStatus, expected] of [
      [3, 3],
      [0, 0],
    ] as const) {
      // `bun` stands in for both the test run and the tail command.
      const script = [
        "set -eo pipefail",
        `output="${directory}/out.log"`,
        "bun() {",
        `  if [[ "$1" == scripts/ci-failure-digest.ts ]]; then echo TAIL-RAN; return 0; fi`,
        `  echo "(fail) a > b"; return ${producerStatus}`,
        "}",
        'timeout() { shift; "$@"; }',
        block,
        "echo AFTER",
      ].join("\n");
      const result = Bun.spawnSync(
        ["bash", "--noprofile", "--norc", "-c", script],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = result.stdout.toString();
      expect(result.exitCode).toBe(expected);
      expect(stdout.includes("TAIL-RAN")).toBe(expected !== 0);
      expect(stdout.includes("AFTER")).toBe(expected === 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
