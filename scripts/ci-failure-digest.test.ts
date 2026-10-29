import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkLogText,
  exitCodeDetail,
  FAILED_CHECK_RECORD,
  failedCheckRecord,
} from "./ci-check-pool";
import {
  annotations,
  type ApiStep,
  BARE_EXIT_CAUSE,
  buildDigest,
  cancelledJobs,
  checkOutputLines,
  classify,
  dedupe,
  DIGEST_ARTIFACT,
  digestFile,
  escapeMarkdown,
  failedTests,
  failureLines,
  type FailureRecord,
  findLocation,
  frameLocation,
  inert,
  isFailedJob,
  MAX_ANNOTATION_LINES,
  MAX_ANNOTATIONS,
  MAX_LINE_WIDTH,
  MAX_LINES_PER_STEP,
  MAX_SCAN_WIDTH,
  parseDigestFile,
  parseJobs,
  playwrightEntry,
  POOLED_FAILURE_PREFIX,
  renderTail,
  RESULT_GATE,
  runIdOf,
  segmentForStep,
  splitSteps,
  stripAnsi,
  summaryMarkdown,
  testFailures,
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
  // The headline names the assertion; the values it compared follow.
  const location = { file: "apps/api/src/math.test.ts", line: 12 };
  expect(failureLines(BUN_FAILURE)).toEqual([
    {
      message:
        "@stll/api: (fail) math > adds (apps/api/src/math.test.ts:12) -- error: expect(received).toBe(expected)",
      ...location,
    },
    { message: "Expected: 3", ...location },
    { message: "Received: 2", ...location },
  ]);
});

test("failed Bun tests keep the package scope and file header they ran under", () => {
  expect(failedTests(BUN_FAILURE)).toEqual([
    { scope: "@stll/api", file: "src/math.test.ts", name: "math > adds" },
  ]);
  // An unhandled error between tests names no test to quarantine.
  expect(
    failedTests(["# Unhandled error between tests", "error: boom"]),
  ).toEqual([]);
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
    { message: "Locator: getByText('Wrong password')" },
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
    dedupe([
      { message: "a" },
      { message: " a " },
      { message: "a", file: "scripts/a.ts", line: 1 },
    ]),
  ).toEqual([{ message: "a", file: "scripts/a.ts", line: 1 }]);
  const many = Array.from(
    { length: MAX_LINES_PER_STEP + 7 },
    (_, index) => `src/a.ts(${index + 1},1): error TS2322: Bad.`,
  );
  expect(failureLines(many)).toHaveLength(MAX_LINES_PER_STEP);
});

test.each(["stall", "signal"])(
  "typed install %s failures remain infrastructure failures through the digest",
  (failureClass) => {
    const lines = failureLines([
      `::error title=install-${failureClass}::kind=infra class=install-${failureClass} restore=cold key=bun-complete-store-v4 elapsed_ms=300000 idle_ms=180000`,
      "Error: Process completed with exit code 1.",
    ]);
    expect(lines.at(0)?.message).toContain(
      `kind=infra class=install-${failureClass}`,
    );
    for (const step of [
      "Install dependencies",
      "Build API image",
      "Test API smoke",
    ]) {
      const kind = classify(step, lines);
      expect(kind).toBe("infra");
      const output = annotations([
        { job: "runner", step, kind, lines, url: "", tests: [] },
      ]);
      expect(output.at(0)).toContain("[infra]");
      expect(output.at(0)).toContain(
        `kind=infra class=install-${failureClass}`,
      );
    }
    expect(classify("Build API image", [{ message: "install-stall" }])).toBe(
      "build",
    );
  },
);

test("a rate-limited E2E stack is a typed infrastructure failure", () => {
  const message =
    "kind=infra class=e2e-stack-rate-limited Docker Hub rate-limited E2E infrastructure pulls; browser tests did not run";
  expect(classify("Start E2E stack", [{ message }])).toBe("infra");
  expect(
    classify("Run Playwright shard", [
      { message },
      { message: "error: expect(received).toBe(expected)" },
    ]),
  ).not.toBe("infra");
});

test.each(["stall", "signal"])(
  "mixed install %s and compiler failures preserve both diagnostics as code",
  (failureClass) => {
    const installer = `kind=infra class=install-${failureClass} restore=cold key=test-key`;
    const compiler =
      "apps/api/src/example.ts(1,1): error TS2322: Type mismatch.";
    expect(
      classify("Build API image", [
        { message: installer },
        { message: compiler },
      ]),
    ).toBe("typecheck");
    for (const body of [
      [`::error title=install-${failureClass}::${installer}`, compiler],
      [compiler, `::error title=install-${failureClass}::${installer}`],
    ]) {
      const records = buildDigest({
        jobs: parseJobs({
          jobs: [
            {
              id: 1,
              name: "api-image",
              conclusion: "failure",
              steps: [
                { name: "Build API image", number: 1, conclusion: "failure" },
              ],
            },
          ],
        }),
        logFor: () =>
          runStep(1, "build", [
            ...body,
            "##[error]Process completed with exit code 1.",
          ]).join("\n"),
      });
      expect(records).toHaveLength(1);
      expect(records.at(0)?.kind).toBe("typecheck");
      expect(
        records
          .at(0)
          ?.lines.map(({ message }) => message)
          .join("\n"),
      ).toContain(installer);
      expect(
        records
          .at(0)
          ?.lines.map(({ message }) => message)
          .join("\n"),
      ).toContain("TS2322");
      const output = annotations(records).join("\n");
      expect(output).toContain("TS2322");
      expect(output).toContain(installer);
    }
  },
);

test.each(["stall", "signal"])(
  "sole install %s evidence remains infra with only a generic exit",
  (failureClass) => {
    const message = `kind=infra class=install-${failureClass} restore=cold key=test-key`;
    for (const suffix of [
      [],
      [{ message: "Process completed with exit code 1." }],
      [{ message: "Error: Process completed with exit code 1." }],
      [{ message: "Install finished; exit 1; signal SIGKILL; restore=cold" }],
    ]) {
      expect(classify("Build API image", [{ message }, ...suffix])).toBe(
        "infra",
      );
    }
    expect(
      classify("Build API image", [
        { message },
        { message: "An unexplained build failure" },
      ]),
    ).toBe("build");
  },
);

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
  tests: [],
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

test("the running gate names its own failed step when no job failed", () => {
  // ci-result digests while it still runs: an outcome step that could not
  // start (for example over the environment size limit) is its only failure.
  const jobs = parseJobs([
    {
      jobs: [
        { id: 1, name: "ci-plan", conclusion: "success", steps: [] },
        {
          id: 2,
          name: "ci-result",
          conclusion: null,
          steps: [
            {
              name: "Fetch GitHub API tooling",
              number: 2,
              conclusion: "success",
            },
            { name: "Evaluate CI outcome", number: 3, conclusion: "failure" },
            { name: "Digest failed steps", number: 4, conclusion: null },
          ],
        },
        {
          id: 3,
          name: "still running cleanly",
          conclusion: null,
          steps: [{ name: "Check", number: 1, conclusion: "success" }],
        },
      ],
    },
  ]);
  expect(jobs.filter(isFailedJob).map(({ id }) => id)).toEqual([2]);
  const records = buildDigest({ jobs, logFor: () => undefined });
  expect(records.map(({ job, step }) => [job, step])).toEqual([
    ["ci-result", "Evaluate CI outcome"],
  ]);
});

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
  const windows: readonly {
    name: string;
    started: string;
    completed: string;
  }[] = [
    {
      name: "Generated files manifest guard",
      started: "10:00:05Z",
      completed: "10:00:07Z",
    },
    {
      name: "Wait for independent repository checks",
      started: "10:00:08Z",
      completed: "10:00:08Z",
    },
  ];
  const steps: ApiStep[] = windows.map(
    ({ name, started, completed }, index) => ({
      name,
      number: index + 1,
      conclusion: "failure",
      started_at: `2026-10-12T${started}`,
      completed_at: `2026-10-12T${completed}`,
    }),
  );
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

test("a diagnostic printed plainly and as an error command is listed once", () => {
  const diagnostic =
    "scripts/a.test.ts(680,7): error TS2322: Type 'string' is not assignable to type 'number'.";
  const lines = failureLines([
    `@stll/scripts:typecheck: ${diagnostic}`,
    diagnostic,
    `##[error]${diagnostic}`,
    `::error file=scripts/a.test.ts,line=680::${diagnostic}`,
  ]);
  expect(lines.map(({ message }) => message)).toEqual([
    "@stll/scripts: scripts/a.test.ts:680 TS2322: Type 'string' is not assignable to type 'number'.",
    "scripts/a.test.ts:680 TS2322: Type 'string' is not assignable to type 'number'.",
  ]);
  expect(lines[1]).toMatchObject({ file: "scripts/a.test.ts", line: 680 });
  expect(
    dedupe([
      { message: "same" },
      { message: "##[error]same" },
      { message: "  ::error title=x::same  ", file: "scripts/b.ts", line: 2 },
    ]),
  ).toEqual([{ message: "same", file: "scripts/b.ts", line: 2 }]);
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

test("pooled check records become named digest failures in runner-rendered logs", () => {
  expect(POOLED_FAILURE_PREFIX).toBe(FAILED_CHECK_RECORD);
  // The runner renders each `::error` annotation as `##[error]<message>`,
  // dropping its title; the pool's plain record keeps the check name.
  // A check's own output, inside its log group, is never a record.
  const log = runStep(4, "bun scripts/ci-check-pool.ts run ci-checks-policy", [
    "##[group]Bun tests: FAILED in 1.0 s",
    failedCheckRecord("Spoofed", "printed by the check"),
    "##[endgroup]",
    "##[error](fail) parser > rejects -- error: expected value",
    failedCheckRecord(
      "Bun tests",
      "(fail) parser > rejects -- error: expected value",
    ),
    "##[error]error: policy failed%",
    failedCheckRecord("Policy -- guard%2D\nnext", "error: policy failed%"),
    "2 check(s) failed: Bun tests; Policy -- guard",
    "##[error]Process completed with exit code 1.",
  ]).join("\n");
  const job = {
    id: 14,
    name: "ci-checks-policy",
    conclusion: "failure",
    html_url: "https://github.com/o/r/actions/runs/1/job/14",
    steps: [
      {
        name: "Run policy checks",
        number: 4,
        conclusion: "failure",
        started_at: "2026-10-12T10:00:04Z",
        completed_at: "2026-10-12T10:00:05Z",
      },
    ],
  };
  const records = buildDigest({ jobs: [job], logFor: () => log });
  expect(records.map(({ step, lines }) => [step, lines[0]?.message])).toEqual([
    ["Bun tests", "(fail) parser > rejects -- error: expected value"],
    ["Policy -- guard%2D\nnext", "error: policy failed%"],
  ]);
});

test("a pooled check that only exited non-zero is digested from its own output", () => {
  expect(BARE_EXIT_CAUSE.test(exitCodeDetail(1))).toBe(true);
  const log = runStep(4, "bun scripts/ci-check-pool.ts run ci-checks-policy", [
    "##[group]Ratchet guard: FAILED in 243.8 s",
    "(pass) allowance without an increase fails [2373.06ms]",
    "ratchet --check: invalid increase allowances:",
    "  direct-third-party-declarations: actual increase 1, funded 0 (unfunded increase).",
    "  direct-third-party-declarations: 677 -> 678 (+1)",
    "      packages/ui/package.json: 30 -> 31",
    "Increases relative to the measured base tree require exact, justified allowances added in this PR.",
    "##[endgroup]",
    `##[error]${exitCodeDetail(1)}`,
    failedCheckRecord("Ratchet guard", exitCodeDetail(1)),
    "1 check(s) failed: Ratchet guard",
    "##[error]Process completed with exit code 1.",
  ]).join("\n");
  const job = {
    id: 15,
    name: "ci-checks-policy",
    conclusion: "failure",
    html_url: "https://github.com/o/r/actions/runs/1/job/15",
    steps: [
      {
        name: "Run policy checks",
        number: 4,
        conclusion: "failure",
        started_at: "2026-10-12T10:00:04Z",
        completed_at: "2026-10-12T10:00:05Z",
      },
    ],
  };
  const [ratchet] = buildDigest({ jobs: [job], logFor: () => log });
  const messages = ratchet?.lines.map(({ message }) => message) ?? [];
  expect(ratchet?.step).toBe("Ratchet guard");
  expect(ratchet?.kind).toBe("ratchet");
  expect(messages).toContain(
    "direct-third-party-declarations: 677 -> 678 (+1)",
  );
  expect(messages).not.toContain(exitCodeDetail(1));
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

  const steps = workflow.jobs[RESULT_GATE]?.steps ?? [];
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
  // `show` downloads this artifact and names this job as the result gate.
  expect(upload?.with?.["name"]).toBe(DIGEST_ARTIFACT);
  expect(upload?.with?.["path"]).toEndWith(`/${DIGEST_ARTIFACT}.json`);
  expect(Object.keys(workflow.jobs)).toContain(RESULT_GATE);

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

test("the recorded network assertion leads the digest despite surrounding output", () => {
  const fixture = readFileSync(
    path.join(import.meta.dir, "fixtures/ci-route-network-failure.txt"),
    "utf-8",
  ).split("\n");
  for (const padding of [0, 100, 10_000]) {
    const lines = failureLines([
      ...Array.from(
        { length: padding },
        () => "[network-baseline] improvement; not a failure",
      ),
      ...fixture,
      ...Array.from({ length: padding }, () => "timing notice"),
    ]);
    expect(lines.at(0)?.message).toContain(
      "Request waterfall got deeper on /settings/organization/vat-rates: 4 -> 5",
    );
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES_PER_STEP);
    expect(lines.every(({ message }) => message.length <= MAX_LINE_WIDTH)).toBe(
      true,
    );
  }
});

test("explicit error markers survive noise anywhere in the saved log", () => {
  for (const marker of [
    "error: assertion failed",
    "::error file=apps/web/src/a.ts,line=9::assertion failed",
    "##[error]assertion failed",
  ]) {
    for (const padding of [0, 100, 10_000]) {
      expect(
        failureLines([
          marker,
          ...Array.from({ length: padding }, () => "timing notice"),
        ]).at(0)?.message,
      ).toContain("assertion failed");
      expect(
        failureLines([
          ...Array.from({ length: padding }, () => "timing notice"),
          marker,
        ]).at(0)?.message,
      ).toContain("assertion failed");
    }
  }
});

test("logs without failure markers retain their closing fallback", () => {
  expect(failureLines(["setup", "last diagnostic"])).toEqual([
    { message: "setup" },
    { message: "last diagnostic" },
  ]);
});

test("annotation-only Playwright output preserves its multiline assertion", () => {
  const fixture = readFileSync(
    path.join(import.meta.dir, "fixtures/ci-route-network-failure.txt"),
    "utf-8",
  ).split("\n");
  const annotation = fixture.filter((line) => line.includes("::error "));
  expect(annotation).toHaveLength(1);
  expect(failureLines(annotation).at(0)?.message).toContain(
    "Request waterfall got deeper on /settings/organization/vat-rates: 4 -> 5",
  );
});

test("located diagnostics do not suppress other explicit errors", () => {
  expect(
    failureLines([
      "scripts/check.ts:9: error: located diagnostic",
      "::error::assertion failed",
    ]).map(({ message }) => message),
  ).toEqual([
    "assertion failed",
    "scripts/check.ts:9: error: located diagnostic",
  ]);
});

test("a detailed Playwright summary beats longer progress noise", () => {
  expect(
    failureLines([
      "✘ 1 [route-smoke] › e2e/routes.spec.ts:1:1 › baseline",
      ...Array.from({ length: 30 }, () => "[network-baseline] not a failure"),
      "1) [route-smoke] › e2e/routes.spec.ts:1:1 › baseline",
      "Error: waterfall assertion failed",
    ]).at(0)?.message,
  ).toContain("waterfall assertion failed");
});

test("terminal verdicts lead earlier negative-fixture annotations", () => {
  for (const padding of [0, 10, 100]) {
    const lines = failureLines([
      ...Array.from(
        { length: 8 },
        (_, index) => `::error::deliberate fixture ${index}`,
      ),
      "PASS negative fixtures",
      ...Array.from({ length: padding }, () => "timing notice"),
      "Validation failed: committed manifest differs",
      "regenerate the manifest",
      "##[error]Process completed with exit code 1.",
    ]);
    expect(lines.at(0)?.message).toBe(
      "Validation failed: committed manifest differs",
    );
    expect(lines.at(1)?.message).toBe("regenerate the manifest");
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES_PER_STEP);
  }
});

test("generic multiline annotations count only decoded diagnostics", () => {
  expect(failureLines(["::error::first%0Asecond"])).toEqual([
    { message: "first" },
    { message: "second" },
  ]);
  for (const length of [2, MAX_LINES_PER_STEP, MAX_LINES_PER_STEP + 2]) {
    const messages = Array.from(
      { length },
      (_, index) => `diagnostic ${index}`,
    );
    expect(
      failureLines([`::error::${messages.join("%0A")}`]).map(
        ({ message }) => message,
      ),
    ).toEqual(messages.slice(0, MAX_LINES_PER_STEP));
  }
});

test("annotation details survive informational output beyond the closing window", () => {
  for (const padding of [0, 100, 10_000]) {
    for (const length of [2, MAX_LINES_PER_STEP, MAX_LINES_PER_STEP + 2]) {
      const messages = [
        "Validation failed:",
        "expected 1, received 2",
        ...Array.from({ length: length - 2 }, (_, index) => `context ${index}`),
      ];
      const lines = failureLines([
        `::error::${messages.join("%0A")}`,
        ...Array.from({ length: padding }, () => "timing notice"),
      ]);
      expect(
        lines
          .map(({ message }) => message)
          .slice(0, Math.min(length, MAX_LINES_PER_STEP)),
      ).toEqual(messages.slice(0, MAX_LINES_PER_STEP));
      expect(lines.length).toBeLessThanOrEqual(MAX_LINES_PER_STEP);
    }
  }
});

// The runner rendering a step's output into the job log. It reads a workflow
// command after leading whitespace, so indenting one never makes it inert.
const renderRunner = (output: string): string[] =>
  output.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("::group::")) {
      return `##[group]${trimmed.slice("::group::".length)}`;
    }
    if (trimmed.startsWith("::endgroup::")) {
      return "##[endgroup]";
    }
    if (trimmed.startsWith("::error")) {
      return `##[error]${trimmed.slice(trimmed.indexOf("::", 2) + 2)}`;
    }
    return line;
  });

type PooledCheck = {
  readonly name: string;
  readonly output: string;
  readonly cause: string;
};

/** A pooled step's log as ci-check-pool.ts prints failed checks. */
const pooledStep = (checks: readonly PooledCheck[]): string =>
  runStep(4, "bun scripts/ci-check-pool.ts run ci-checks-rest", [
    ...checks.flatMap(({ name, output, cause }) => [
      `##[group]${name}: FAILED in 8.5 s`,
      ...renderRunner(checkLogText(output, "failure")),
      "##[endgroup]",
      `##[error]${cause}`,
      failedCheckRecord(name, cause),
    ]),
    `${checks.length} check(s) failed: ${checks.map(({ name }) => name).join("; ")}`,
    "##[error]Process completed with exit code 1.",
  ]).join("\n");

const poolJob = {
  id: 21,
  name: "ci-checks-rest (2)",
  conclusion: "failure",
  html_url: "https://github.com/o/r/actions/runs/1/job/21",
  steps: [
    {
      name: "Run repository checks",
      number: 4,
      conclusion: "failure",
      started_at: "2026-10-12T10:00:04Z",
      completed_at: "2026-10-12T10:00:05Z",
    },
  ],
};

// Shapes from a real failing run. A backlog check runs its own tests (Bun
// groups each test file) and prints its findings after them.
const BACKLOG_CHECK_OUTPUT = [
  "bun test v1.4.4 (38afee6c8)",
  "",
  "::group::scripts/design-lint-baseline.test.ts:",
  "(pass) each rule is budgeted on its own [0.05ms]",
  "(pass) a fall below the baseline fails the check like a rise does [0.09ms]",
  "",
  "::endgroup::",
  "",
  " 2 pass",
  " 0 fail",
  " 12 expect() calls",
  "Ran 2 tests across 1 file. [540.00ms]",
  "",
  "Lint findings fell in 2 backlog entries:",
  "  require-bounded-request-schema apps/api/src/handlers/search/ai.ts (1, baseline 2)",
  "  require-bounded-request-schema apps/api/src/handlers/tasks/calendar/list.ts (2, baseline 4)",
  "",
  "Run `bun scripts/design-lint-baseline.ts --write` and commit the baseline.",
].join("\n");

// A check whose `bun run` exit names no cause, after informational logging.
const AGGREGATE_CHECK_OUTPUT = [
  "$ bun scripts/check-aggregate-mutations.ts",
  '{"severity":"INFO","message":"database.shared_pool_timeout_configured","pool":"root","idleTimeoutMs":0}',
  "Undeclared aggregate mutation: PATCH /mcp",
  "Undeclared aggregate mutation: PUT /mcp",
  "Aggregate mutation coverage: 37 verified declarations, 449 undeclared mutation routes, 438 legacy entries",
  'error: script "check:aggregate-mutations" exited with code 1',
].join("\n");

// Lint findings printed as error commands and again by the affected runner,
// behind Node's process warnings.
const LINT_CHECK_OUTPUT = [
  "(node:5557) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///home/runner/work/stella/stella/scripts/check-oxlint-design-system.ts is not specified and it doesn't parse as CommonJS.",
  "Reparsing as ES module because module syntax was detected. This incurs a performance overhead.",
  'To eliminate this warning, add "type": "module" to /home/runner/work/stella/stella/package.json.',
  "(Use `node --trace-warnings ...` to show where the warning was created)",
  "::error::.oxlint-plugins/no-offset-pagination.ts:35:3: Use 'String#endsWith' method instead.",
  "",
  "Found 0 warnings and 1 error.",
  'error: "oxlint" exited with code 1',
  "code-check: failed (exit 1): bash scripts/lint-oxlint-fixtures.sh",
  "    typescript(prefer-string-starts-ends-with): .oxlint-plugins/no-offset-pagination.ts:35:3: Use 'String#endsWith' method instead.",
  'error: script "code-check:affected" exited with code 1',
].join("\n");

const messagesOf = (failure: FailureRecord | undefined): string[] =>
  failure?.lines.map(({ message }) => message) ?? [];

test("a pooled check's own test groups never hide the findings printed after them", () => {
  const rendered = renderRunner(checkLogText(BACKLOG_CHECK_OUTPUT, "failure"));
  // Bun's file header stays a plain line, so no group nests in the check's.
  expect(rendered).toContain("scripts/design-lint-baseline.test.ts:");
  expect(rendered.filter((line) => line.startsWith("##["))).toEqual([]);
  const [backlog] = buildDigest({
    jobs: [poolJob],
    logFor: () =>
      pooledStep([
        {
          name: "Design-system lint backlog",
          output: BACKLOG_CHECK_OUTPUT,
          cause: exitCodeDetail(1),
        },
      ]),
  });
  expect(backlog?.step).toBe("Design-system lint backlog");
  expect(messagesOf(backlog)).toEqual([
    "Lint findings fell in 2 backlog entries:",
    "require-bounded-request-schema apps/api/src/handlers/search/ai.ts (1, baseline 2)",
    "require-bounded-request-schema apps/api/src/handlers/tasks/calendar/list.ts (2, baseline 4)",
    "Run `bun scripts/design-lint-baseline.ts --write` and commit the baseline.",
  ]);
});

test("a pooled check whose cause restates a runner exit is read from its output", () => {
  const records = buildDigest({
    jobs: [poolJob],
    logFor: () =>
      pooledStep([
        {
          name: "Aggregate ownership",
          output: AGGREGATE_CHECK_OUTPUT,
          cause: 'error: script "check:aggregate-mutations" exited with code 1',
        },
        {
          name: "Code quality (rest)",
          output: LINT_CHECK_OUTPUT,
          cause: 'error: "oxlint" exited with code 1',
        },
      ]),
  });
  expect(records.map(({ step }) => step)).toEqual([
    "Aggregate ownership",
    "Code quality (rest)",
  ]);
  expect(messagesOf(records[0])).toEqual([
    "$ bun scripts/check-aggregate-mutations.ts",
    "Undeclared aggregate mutation: PATCH /mcp",
    "Undeclared aggregate mutation: PUT /mcp",
    "Aggregate mutation coverage: 37 verified declarations, 449 undeclared mutation routes, 438 legacy entries",
  ]);
  expect(messagesOf(records[1])).toEqual([
    ".oxlint-plugins/no-offset-pagination.ts:35:3: Use 'String#endsWith' method instead.",
    "Found 0 warnings and 1 error.",
    "code-check: failed (exit 1): bash scripts/lint-oxlint-fixtures.sh",
    "typescript(prefer-string-starts-ends-with): .oxlint-plugins/no-offset-pagination.ts:35:3: Use 'String#endsWith' method instead.",
  ]);
  expect(records[1]?.lines[0]).toMatchObject({
    file: ".oxlint-plugins/no-offset-pagination.ts",
    line: 35,
  });
  expect(records[1]?.kind).toBe("lint");
});

test("a check's closing lines keep the last distinct lines, never passing tests", () => {
  const output = [
    "(pass) a [1ms]",
    ...Array.from(
      { length: MAX_LINES_PER_STEP + 5 },
      (_, index) => `finding ${index}`,
    ),
    "finding 0",
    "(pass) b [1ms]",
  ];
  const { specific, lines } = checkOutputLines(output);
  expect(specific).toBe(false);
  expect(lines.map(({ message }) => message)).toEqual(
    Array.from(
      { length: MAX_LINES_PER_STEP },
      (_, index) => `finding ${index + 5}`,
    ),
  );
});

test("a failing test lists the errors and values below its headline, not its source", () => {
  const lines = failureLines([
    "@stll/api:test: src/lib/compiled-http-validation.artifact.test.ts:",
    "@stll/api:test: 82 |     expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);",
    "@stll/api:test:                                                                         ^",
    `@stll/api:test: error: 7 | import { serveForTest } from "${WORK}/apps/api/src/http/test-server.ts";`,
    "@stll/api:test:                                  ^",
    `@stll/api:test: error: Could not resolve: "${WORK}/apps/api/src/http/test-server.ts"`,
    "@stll/api:test:     at /tmp/stella-http-artifact-i9nFBC/probe.ts:7:30",
    "@stll/api:test: ",
    "@stll/api:test: Expected: 0",
    "@stll/api:test: Received: 1",
    "@stll/api:test: ",
    `@stll/api:test:       at <anonymous> (${WORK}/apps/api/src/lib/compiled-http-validation.artifact.test.ts:82:68)`,
    "@stll/api:test: (fail) the compiled HTTP core validates synchronous and asynchronous Standard Schema bodies [8.47ms]",
  ]).map(({ message }) => message);
  expect(lines.at(0)).toContain("(fail)");
  expect(lines.slice(1)).toEqual([
    `error: Could not resolve: "${WORK}/apps/api/src/http/test-server.ts"`,
    "Expected: 0",
    "Received: 1",
  ]);
  expect(lines.join("\n")).not.toContain("82 |");
});

test("an annotation shows the first lines of a longer record", () => {
  const lines = Array.from(
    { length: MAX_ANNOTATION_LINES + 3 },
    (_, index) => ({ message: `line ${index}` }),
  );
  const [command] = annotations([{ ...record(0), lines }]);
  expect(command?.split("::").at(-1)?.split("%0A")).toEqual(
    lines.slice(0, MAX_ANNOTATION_LINES).map(({ message }) => message),
  );
});

const apiJob = (
  id: number,
  name: string,
  conclusion: string | null,
  steps: readonly ApiStep[],
) => ({
  id,
  name,
  conclusion,
  html_url: `https://example.test/job/${id}`,
  steps,
});

const POLICY_FAILURE = apiJob(1, "ci-checks-policy", "failure", [
  { name: "Run policy checks", number: 4, conclusion: "failure" },
]);
const CANCELLED_SHARD = apiJob(2, "ci-tests (api-3)", "cancelled", [
  { name: "Test API or rest", number: 12, conclusion: "cancelled" },
]);
const MASKED_FAILURE = apiJob(3, "ci-tests (api-1)", "cancelled", [
  { name: "Test API or rest", number: 12, conclusion: "failure" },
]);
const RUNNING_GATE = apiJob(4, RESULT_GATE, null, [
  { name: "Evaluate CI outcome", number: 3, conclusion: "failure" },
]);

test("cancelled jobs are listed apart and the gate never restates other failures", () => {
  const jobs = parseJobs([
    { jobs: [POLICY_FAILURE, CANCELLED_SHARD, MASKED_FAILURE, RUNNING_GATE] },
  ]);
  const records = buildDigest({ jobs, logFor: () => undefined });
  // A cancelled job with a failed step is a failure, not a cancellation.
  expect(records.map(({ job }) => job)).toEqual([
    "ci-checks-policy",
    "ci-tests (api-1)",
  ]);
  // Read back after the run, the gate has finished; its name still marks it.
  const finished = parseJobs([
    { jobs: [POLICY_FAILURE, { ...RUNNING_GATE, conclusion: "failure" }] },
  ]);
  expect(
    buildDigest({
      jobs: finished,
      logFor: () => undefined,
      gate: RESULT_GATE,
    }).map(({ job }) => job),
  ).toEqual(["ci-checks-policy"]);

  const cancelled = cancelledJobs(jobs);
  expect(cancelled).toEqual([
    {
      job: "ci-tests (api-3)",
      url: "https://example.test/job/2",
      reason: "after-failure",
    },
  ]);
  expect(cancelledJobs(parseJobs([{ jobs: [CANCELLED_SHARD] }]))).toEqual([
    {
      job: "ci-tests (api-3)",
      url: "https://example.test/job/2",
      reason: "no-failure",
    },
  ]);
  const summary = summaryMarkdown(records, cancelled);
  expect(summary).toContain(
    "**Cancelled, not failed** (1): ci-tests (api-3). stopped after another job failed",
  );
  expect(summary).not.toContain("**ci-tests (api-3) /");
});

test("a digest artifact reads back as written; run ids come from ids or URLs", () => {
  const failures: FailureRecord[] = [
    {
      ...record(0),
      lines: [{ message: "a", file: "apps/a.ts", line: 3 }, { message: "b" }],
    },
  ];
  const cancelled = cancelledJobs(
    parseJobs([{ jobs: [POLICY_FAILURE, CANCELLED_SHARD] }]),
  );
  // The artifact is the JSON text the digest command writes.
  const text = JSON.stringify(
    digestFile(failures, { GITHUB_RUN_ID: "5" }, cancelled),
  );
  const written: unknown = JSON.parse(text);
  expect(parseDigestFile(written)).toEqual({ failures, cancelled });
  // A digest from before cancelled jobs were recorded lists none.
  expect(parseDigestFile({ version: 1, failures: [] })).toEqual({
    failures: [],
    cancelled: [],
  });
  expect(parseDigestFile({ version: 0, failures: [] })).toBeUndefined();

  expect(runIdOf("40137279936")).toBe("40137279936");
  for (const url of [
    "https://github.com/o/r/actions/runs/40137279936",
    "https://github.com/o/r/actions/runs/40137279936/job/121003611661",
    "https://github.com/o/r/actions/runs/40137279936/attempts/2",
  ]) {
    expect(runIdOf(url)).toBe("40137279936");
  }
  expect(runIdOf("https://github.com/o/r/pull/6710")).toBeUndefined();
  expect(runIdOf("latest")).toBeUndefined();
});

// Stands in for gh: `run download` serves $FAKE_ARTIFACT when set; `api`
// serves the run's jobs and the logs under $FAKE_LOGS.
const FAKE_GH = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "$FAKE_CALLS"',
  'if [[ "$1" == run && "$2" == download ]]; then',
  '  [[ -n "$FAKE_ARTIFACT" ]] || exit 1',
  '  while (($#)); do if [[ "$1" == --dir ]]; then dir=$2; fi; shift; done',
  '  cp "$FAKE_ARTIFACT" "$dir/ci-failures.json"',
  "  exit 0",
  "fi",
  "for endpoint; do :; done",
  'case "$endpoint" in',
  '  repos/o/r/actions/runs/7/jobs*) cat "$FAKE_JOBS" ;;',
  '  repos/o/r/actions/jobs/*/logs) id=$(basename "$(dirname "$endpoint")"); cat "$FAKE_LOGS/$id.log" 2>/dev/null || exit 1 ;;',
  "  *) exit 1 ;;",
  "esac",
].join("\n");

test("show prints a run's digest from its artifact, else from its job logs", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-digest-show-"));
  try {
    const bin = path.join(directory, "bin");
    const logs = path.join(directory, "logs");
    mkdirSync(bin);
    mkdirSync(logs);
    writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
    const policy = apiJob(11, "ci-checks-policy", "failure", [
      {
        name: "Ratchet guard",
        number: 3,
        conclusion: "failure",
        started_at: "2026-10-12T10:00:04Z",
        completed_at: "2026-10-12T10:00:08Z",
      },
    ]);
    writeFileSync(
      path.join(directory, "jobs.json"),
      JSON.stringify([
        {
          jobs: [
            policy,
            CANCELLED_SHARD,
            { ...RUNNING_GATE, conclusion: "failure" },
          ],
        },
      ]),
    );
    writeFileSync(path.join(logs, "11.log"), JOB_LOG);
    const show = (artifact?: string) =>
      Bun.spawnSync(
        [
          process.execPath,
          path.join(ROOT, "scripts/ci-failure-digest.ts"),
          "show",
          "https://github.com/o/r/actions/runs/7/job/11",
          "--repo",
          "o/r",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
            FAKE_CALLS: path.join(directory, "calls"),
            FAKE_JOBS: path.join(directory, "jobs.json"),
            FAKE_LOGS: logs,
            ...(artifact === undefined ? {} : { FAKE_ARTIFACT: artifact }),
          },
        },
      );

    const fromLogs = show();
    expect(fromLogs.exitCode).toBe(0);
    expect(fromLogs.stderr.toString()).toBe(
      `Run 7 has no ${DIGEST_ARTIFACT} artifact; digested from its job logs.\n`,
    );
    const markdown = fromLogs.stdout.toString();
    expect(markdown).toContain(
      "**ci-checks-policy / Ratchet guard** `ratchet`",
    );
    expect(markdown).toContain("as-casts: 10 -> 11 (+1)");
    expect(markdown).toContain(
      "**Cancelled, not failed** (1): ci-tests (api-3).",
    );
    expect(markdown).not.toContain(`${RESULT_GATE} /`);
    // Only failed jobs' logs are fetched, and the gate's is never needed.
    const calls = readFileSync(path.join(directory, "calls"), "utf-8");
    expect(calls).toContain("repos/o/r/actions/jobs/11/logs");
    expect(calls).not.toContain("repos/o/r/actions/jobs/2/logs");

    const artifact = path.join(directory, "artifact.json");
    const failures = [record(0)];
    writeFileSync(artifact, JSON.stringify(digestFile(failures, {})));
    const fromArtifact = show(artifact);
    expect(fromArtifact.exitCode).toBe(0);
    expect(fromArtifact.stderr.toString()).toBe("");
    expect(fromArtifact.stdout.toString()).toBe(summaryMarkdown(failures));

    rmSync(path.join(logs, "11.log"));
    const unavailable = show();
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.stdout.toString()).toContain(
      'Log of job "ci-checks-policy" was unavailable to the digest.',
    );
    expect(unavailable.stderr.toString()).toContain("GitHub command failed:");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
