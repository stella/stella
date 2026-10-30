import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import * as v from "valibot";

import { heavyVerdict, type HeavyVerdictInput } from "./release-heavy-verdict";

const repoRoot = nodePath.resolve(import.meta.dirname, "..");

const WorkflowSchema = v.looseObject({
  jobs: v.record(
    v.string(),
    v.looseObject({
      name: v.optional(v.string()),
      uses: v.optional(v.string()),
      steps: v.optional(
        v.array(
          v.looseObject({
            name: v.optional(v.string()),
            if: v.optional(v.string()),
          }),
        ),
      ),
    }),
  ),
});

const readYaml = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(nodePath.join(repoRoot, file), "utf-8"));

const readWorkflow = (file: string) =>
  v.parse(WorkflowSchema, readYaml(`.github/workflows/${file}`));

const callerOf = (workflow: ReturnType<typeof readWorkflow>, uses: string) =>
  Object.entries(workflow.jobs).flatMap(([id, job]) =>
    job.uses === uses ? [id] : [],
  );

const HEAD = "d".repeat(40);
const RUN_ID = 7;
const MARKETING = "suites / marketing-screenshots / check";
const CAPTURE_STEP = "Capture marketing screenshots";
const MARKER_STEP = "Screenshot comparison failed";

const step = (name: string, conclusion: string | null) => ({
  name,
  conclusion,
});
const COMPARISON_FAILED_STEPS = [
  step("Set up job", "success"),
  step("Checkout", "success"),
  step(CAPTURE_STEP, "failure"),
  step("Read screenshot comparison phase", "success"),
  step(MARKER_STEP, "success"),
  step("Upload failure diagnostics", "success"),
];
const job = (
  name: string,
  conclusion: string | null,
  steps?: readonly unknown[],
) => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  ...(steps === undefined ? {} : { steps }),
});
const marketingJob = (steps: readonly unknown[] = COMPARISON_FAILED_STEPS) =>
  job(MARKETING, "failure", steps);
const ROLLUPS = [
  job("suites / ci-result", "failure"),
  job("status", "failure"),
];

const MARKETING_VIOLATION = "marketing-screenshots (planned, failure)";
const record = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  run_id: RUN_ID,
  run_attempt: 1,
  head_sha: HEAD,
  basis: "evaluated",
  depth: "heavy",
  verdict: "failure",
  required: [
    { job: "ci-tests", conclusion: "success" },
    { job: "e2e-production-shard", conclusion: "success" },
    { job: "marketing-screenshots", conclusion: "failure" },
  ],
  ...overrides,
});

// The separate `ci-required-violations` artifact.
const violationsRecord = (overrides: Record<string, unknown> = {}) => ({
  run_id: RUN_ID,
  run_attempt: 1,
  head_sha: HEAD,
  evaluated: true,
  violations: MARKETING_VIOLATION,
  ...overrides,
});

const verdictOf = (overrides: Partial<HeavyVerdictInput> = {}) => {
  const jobs = overrides.jobs ?? [
    job("suites / ci-tests", "success"),
    marketingJob(),
    ...ROLLUPS,
  ];
  return heavyVerdict({
    jobs,
    total: Array.isArray(jobs) ? jobs.length : 0,
    record: record(),
    violations: violationsRecord(),
    runId: RUN_ID,
    head: HEAD,
    ...overrides,
  });
};

const announced = verdictOf();

test("the advisory names are the ones the workflows report", () => {
  const heavy = readWorkflow("main-heavy.yml");
  const ci = readWorkflow("ci.yml");
  const screenshots = readWorkflow("marketing-screenshots.yml");
  const [suites, ...otherCallers] = callerOf(
    heavy,
    "./.github/workflows/ci.yml",
  );
  const [marketing, ...otherMarketing] = callerOf(
    ci,
    "./.github/workflows/marketing-screenshots.yml",
  );
  expect(suites).toBeDefined();
  expect(otherCallers).toEqual([]);
  expect(marketing).toBeDefined();
  expect(otherMarketing).toEqual([]);
  expect(Object.keys(screenshots.jobs)).toEqual(["check"]);
  expect(screenshots.jobs["check"]?.name).toBeUndefined();
  // GitHub names a called job `<caller id> / <called job name or id>`.
  expect(announced.advisoryJobs).toEqual([
    `${suites ?? ""} / ${marketing ?? ""} / check`,
  ]);
  // The record names the job by its id in ci.yml's `needs`.
  expect(announced.advisoryRequiredJob).toBe(marketing);
  const ciResult = ci.jobs["ci-result"];
  expect(ciResult?.name).toBe("ci-result");
  expect(heavy.jobs["status"]?.name).toBeUndefined();
  expect(announced.aggregateJobs).toEqual([
    `${suites ?? ""} / ${ciResult?.name ?? ""}`,
    "status",
  ]);
});

test("the comparison step and its marker are the steps the workflows define", () => {
  const steps = readWorkflow("marketing-screenshots.yml").jobs["check"]?.steps;
  const names = (steps ?? []).map(({ name }) => name);
  expect(announced.advisoryStep).toBe(CAPTURE_STEP);
  expect(announced.comparisonMarkerStep).toBe(MARKER_STEP);
  expect(names).toContain(announced.advisoryStep);
  // The marker step exists only for a failure after the comparison started.
  const marker = (steps ?? []).find(({ name }) => name === MARKER_STEP);
  expect(marker?.if).toContain("failure()");
  expect(marker?.if).toContain("steps.comparison.outputs.started");
  expect(names.indexOf(MARKER_STEP)).toBeGreaterThan(
    names.indexOf(CAPTURE_STEP),
  );
  // The composite writes the started marker right before the capture step
  // and clears it only when that step finishes.
  const action = readFileSync(
    nodePath.join(repoRoot, ".github/actions/marketing-capture/action.yml"),
    "utf-8",
  );
  const started = action.indexOf("marketing-comparison-started");
  const capture = action.indexOf(`- name: ${CAPTURE_STEP}`);
  const cleared = action.indexOf("rm -f", capture);
  expect(started).toBeGreaterThan(-1);
  expect(started).toBeLessThan(capture);
  expect(cleared).toBeGreaterThan(capture);
});

test("ci-result publishes the unmet checks as an artifact of its own", () => {
  const ci = readFileSync(
    nodePath.join(repoRoot, ".github/workflows/ci.yml"),
    "utf-8",
  );
  expect(ci).toContain("name: ci-required-violations");
  expect(ci).toContain("ci-required-violations/ci-required-violations.json");
  // The violation text the filter expects is the one ci-result renders.
  expect(ci).toContain('"\\($suite) (planned, \\($result))"');
  expect(ci).toContain('"\\($job) (planned, \\($result))"');
});

// merge-bar parses the record with a closed key set, so the verdict must
// travel in its own artifact. This is the key set on main.
const REQUIRED_SUMMARY_KEYS = [
  "version",
  "event",
  "head_sha",
  "base_sha",
  "run_id",
  "run_attempt",
  "depth",
  "coverage_profile",
  "reused_from_run_id",
  "basis",
  "pass_through_reason",
  "required",
  "not_required",
  "verdict",
];

test("the required-jobs record keeps exactly its established key set", () => {
  const ci = readFileSync(
    nodePath.join(repoRoot, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const start = ci.indexOf("| {version: 1, event: $event,");
  const end = ci.indexOf('<<< "$RECORDED_NEEDS")', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const literal = ci
    .slice(start, end)
    // The nested {job, conclusion} entries are not top-level keys.
    .replace(/\{job: \., conclusion: [^}]*\}/gu, "");
  const keys = [...literal.matchAll(/(?:\{|,|\s)([a-z_]+):/gu)].map(
    ([, key]) => key,
  );
  expect(keys).toEqual(REQUIRED_SUMMARY_KEYS);
});

test("a comparison-only screenshot failure with every other entry green is advisory", () => {
  const verdict = verdictOf();
  expect(verdict).toMatchObject({ advisory: [MARKETING], blocking: [] });
  expect(verdict.advisoryOnly).toBe(true);
});

test.each([
  [
    "a skipped planned required job",
    {
      record: record({
        required: [
          { job: "e2e-production-shard", conclusion: "skipped" },
          { job: "marketing-screenshots", conclusion: "failure" },
        ],
      }),
    },
    "e2e-production-shard (skipped)",
  ],
  [
    "a folded sub-suite that is not success",
    {
      violations: violationsRecord({
        violations: `${MARKETING_VIOLATION}, api-image-deps (planned, failure)`,
      }),
    },
    "unmet checks",
  ],
  [
    "a job missing from JOB_SCOPES",
    {
      violations: violationsRecord({
        violations: `${MARKETING_VIOLATION}, new-suite (no entry in JOB_SCOPES)`,
      }),
    },
    "unmet checks",
  ],
  [
    "violations that were never evaluated",
    { violations: violationsRecord({ evaluated: false }) },
    "did not evaluate",
  ],
  [
    "a violations record of another run",
    { violations: violationsRecord({ run_id: RUN_ID + 1 }) },
    "another run, attempt or commit",
  ],
  [
    "a violations record of another commit",
    { violations: violationsRecord({ head_sha: "e".repeat(40) }) },
    "another run, attempt or commit",
  ],
  [
    "a violations record of another attempt",
    { violations: violationsRecord({ run_attempt: 2 }) },
    "another run, attempt or commit",
  ],
  [
    "an absent violations record",
    { violations: null },
    "required-violations record unreadable",
  ],
  [
    "a violations record that is not an object",
    { violations: [] },
    "required-violations record unreadable",
  ],
  [
    "a record of another run",
    { record: record({ run_id: RUN_ID + 1 }) },
    "another run or commit",
  ],
  [
    "a record of another commit",
    { record: record({ head_sha: "e".repeat(40) }) },
    "another run or commit",
  ],
  [
    "a record without a failed screenshots entry",
    {
      record: record({
        required: [{ job: "marketing-screenshots", conclusion: "success" }],
      }),
    },
    "no failed marketing-screenshots",
  ],
  ["an unreadable record", { record: null }, "required-jobs record unreadable"],
  [
    "a record that is not an object",
    { record: [] },
    "required-jobs record unreadable",
  ],
])("%s is not advisory-only", (_label, overrides, reason) => {
  const verdict = verdictOf(overrides);
  expect(verdict.advisoryOnly).toBe(false);
  expect(verdict.blocking.join("\n")).toContain(reason);
});

test.each([
  [
    "a seed step",
    [
      step("Set up job", "success"),
      step(CAPTURE_STEP, "failure"),
      step(MARKER_STEP, "skipped"),
    ],
  ],
  [
    "the comparison step plus an earlier checkout",
    [
      step("Checkout", "failure"),
      step(CAPTURE_STEP, "failure"),
      step(MARKER_STEP, "success"),
    ],
  ],
  [
    "a diagnostics upload after the comparison",
    [
      step(CAPTURE_STEP, "failure"),
      step(MARKER_STEP, "success"),
      step("Upload failure diagnostics", "failure"),
    ],
  ],
  ["a job without steps", undefined],
])("a failure in %s is not a comparison failure", (_label, steps) => {
  const verdict = verdictOf({
    jobs: [
      job("suites / ci-tests", "success"),
      job(MARKETING, "failure", steps),
      ...ROLLUPS,
    ],
  });
  expect(verdict.advisoryOnly).toBe(false);
  expect(verdict.blocking).toContain(`${MARKETING} (failure)`);
});

test("any other unsuccessful job blocks", () => {
  const verdict = verdictOf({
    jobs: [
      marketingJob(),
      job("suites / api-tests (2)", "failure"),
      ...ROLLUPS,
    ],
  });
  expect(verdict.advisoryOnly).toBe(false);
  expect(verdict.blocking).toEqual(["suites / api-tests (2) (failure)"]);
});

test("an aggregate failure without an advisory failure blocks", () => {
  const verdict = verdictOf({ jobs: ROLLUPS, record: record() });
  expect(verdict.advisoryOnly).toBe(false);
  expect(verdict.blocking).toHaveLength(2);
});

test("a job count different from the API total_count blocks", () => {
  const jobs = [marketingJob(), ...ROLLUPS];
  for (const total of [jobs.length + 1, jobs.length - 1, null, "3"]) {
    const verdict = verdictOf({ jobs, total });
    expect(verdict.advisoryOnly).toBe(false);
    expect(verdict.blocking.join("\n")).toContain("job list incomplete");
  }
});

test.each([
  [
    "a cancelled advisory job",
    [job(MARKETING, "cancelled", COMPARISON_FAILED_STEPS)],
  ],
  ["an unfinished job", [marketingJob(), job("suites / e2e", null)]],
  [
    "an unknown job name",
    [
      job(
        "suites / marketing-shots / check",
        "failure",
        COMPARISON_FAILED_STEPS,
      ),
    ],
  ],
  ["a nameless job", [marketingJob(), { conclusion: "failure" }]],
  ["a non-object entry", [marketingJob(), 3]],
  ["a missing job list", "unreadable"],
  ["an empty job list", []],
])("%s is not advisory-only", (_label, jobs) => {
  expect(verdictOf({ jobs }).advisoryOnly).toBe(false);
});
