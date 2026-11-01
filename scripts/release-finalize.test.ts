import { expect, test } from "bun:test";

import { finalize } from "./release-finalize.fixture";

test("finalizes only the exact RC SHA when every evidence item is green", () => {
  const proof = finalize();
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.finalSha).toBe(proof.sha);
  expect(proof.pushes).toContain("refs/tags/v1.2.3");
  expect(proof.publications).toContain("release edit v1.2.3-rc.2");
});

for (const context of ["staging/verified", "main/heavy", "main/pr-depth"]) {
  for (const state of ["failure", "pending", "missing"]) {
    test(`${context} ${state} creates no final tag or publication`, () => {
      const proof = finalize({ states: { [context]: state } });
      expect(proof.result.exitCode).not.toBe(0);
      expect(proof.finalSha).toBeNull();
      expect(proof.pushes).toBe("");
      expect(proof.publications).toBe("");
    });
  }
}

for (const [name, gate, now] of [
  ["a missing", "missing", "missing"],
  ["a pending", { state: "pending", creator: "User" }, "pending"],
  ["a failed", { state: "failure", creator: "User" }, "failure"],
  ["a bot's", { state: "success", creator: "Bot" }, "not-a-person"],
] as const) {
  test(`${name} release/prod-gate waits without a final tag or publication`, () => {
    const proof = finalize({ gate });
    expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
    expect(proof.result.stderr.toString()).toContain(
      `waits for release/prod-gate=success on ${proof.sha} (now: ${now})`,
    );
    expect(proof.finalSha).toBeNull();
    expect(proof.pushes).toBe("");
    expect(proof.publications).toBe("");
  });
}

test("green receipts for another SHA create no final tag", () => {
  const proof = finalize({ runSha: "f".repeat(40) });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.finalSha).toBeNull();
});
test("an unresolved incident creates no final tag", () => {
  const proof = finalize({ incidents: true });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.finalSha).toBeNull();
});
test("a missing RC performs no writes", () => {
  const proof = finalize({ noRc: true });
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.pushes).toBe("");
  expect(proof.publications).toBe("");
});

test("an existing final tag on another commit refuses without writes", () => {
  const proof = finalize({ finalTag: "previous", rcPublication: "draft" });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.result.stderr.toString()).toContain(
    "Final tag v1.2.3 already exists",
  );
  expect(proof.pushes).toBe("");
  expect(proof.publications).toBe("");
});

test("a failed publication after the tag push leaves the RC a draft", () => {
  const proof = finalize({ rcPublication: "draft", publicationFails: true });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.pushes).toContain("refs/tags/v1.2.3");
  expect(proof.publications).toBe("");
});

// The retry of that failure: the tag is already on the candidate.
test("a retry with the final tag on the candidate publishes without pushing again", () => {
  const proof = finalize({ finalTag: "candidate", rcPublication: "draft" });
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.result.stderr.toString()).toContain("resuming publication");
  expect(proof.pushes).toBe("");
  expect(proof.publications).toContain("release edit v1.2.3-rc.2");
});

const MARKETING_JOB = "suites / marketing-screenshots / check";
const CAPTURE_STEP = "Capture marketing screenshots";
const MARKER_STEP = "Screenshot comparison failed";
// The heavy run is the fixture's second run, so the record names run 2.
const HEAVY_RUN_ID = 2;

type HeavyStep = { name: string; conclusion: string | null };
const heavyJob = (
  name: string,
  conclusion: string | null,
  steps?: readonly HeavyStep[],
) => ({
  name,
  run_attempt: 1,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  ...(steps === undefined ? {} : { steps }),
});
const COMPARISON_STEPS = [
  { name: "Set up job", conclusion: "success" },
  { name: CAPTURE_STEP, conclusion: "failure" },
  { name: MARKER_STEP, conclusion: "success" },
];
const marketingJob = (steps: readonly HeavyStep[] = COMPARISON_STEPS) =>
  heavyJob(MARKETING_JOB, "failure", steps);
const ROLLUP_JOBS = [
  heavyJob("suites / ci-result", "failure"),
  heavyJob("status", "failure"),
];
const requiredRecord =
  (overrides: Record<string, unknown> = {}) =>
  (sha: string) => ({
    version: 1,
    run_id: HEAVY_RUN_ID,
    head_sha: sha,
    basis: "evaluated",
    depth: "heavy",
    run_attempt: 1,
    verdict: "failure",
    required: [
      { job: "e2e-production-shard", conclusion: "success" },
      { job: "marketing-screenshots", conclusion: "failure" },
    ],
    ...overrides,
  });

const requiredViolations =
  (overrides: Record<string, unknown> = {}) =>
  (sha: string) => ({
    run_id: HEAVY_RUN_ID,
    run_attempt: 1,
    head_sha: sha,
    evaluated: true,
    violations: "marketing-screenshots (planned, failure)",
    ...overrides,
  });

type FailedHeavyOptions = {
  jobs: readonly ReturnType<typeof heavyJob>[];
  conclusion?: string;
  total?: number;
  record?: ((sha: string) => unknown) | null;
  violations?: ((sha: string) => unknown) | null;
};
const failedHeavy = ({
  jobs,
  conclusion = "failure",
  total,
  record = requiredRecord(),
  violations = requiredViolations(),
}: FailedHeavyOptions) =>
  finalize({
    states: { "main/heavy": "failure" },
    heavyRun: {
      conclusion,
      jobs,
      ...(total === undefined ? {} : { total }),
      ...(record === null ? {} : { record }),
      ...(violations === null ? {} : { violations }),
    },
  });

test("artifacts of attempt 1 with the run at attempt 2 refuse", () => {
  const proof = finalize({
    states: { "main/heavy": "failure" },
    heavyRun: {
      conclusion: "failure",
      jobs: [marketingJob(), ...ROLLUP_JOBS],
      runAttempt: 2,
      record: requiredRecord(),
      violations: requiredViolations(),
    },
  });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.result.stderr.toString()).toContain("attempt");
  expect(proof.finalSha).toBeNull();
});

test("jobs and artifacts from the run's attempt finalize", () => {
  const proof = finalize({
    states: { "main/heavy": "failure" },
    heavyRun: {
      conclusion: "failure",
      jobs: [marketingJob(), ...ROLLUP_JOBS].map((entry) => ({
        ...entry,
        run_attempt: 2,
      })),
      runAttempt: 2,
      record: requiredRecord({ run_attempt: 2 }),
      violations: requiredViolations({ run_attempt: 2 }),
    },
  });
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.finalSha).toBe(proof.sha);
});

test("a heavy run that failed only in the screenshot comparison finalizes with a warning", () => {
  const proof = failedHeavy({
    jobs: [
      heavyJob("suites / web-tests", "success"),
      marketingJob(),
      ...ROLLUP_JOBS,
    ],
  });
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.finalSha).toBe(proof.sha);
  const stderr = proof.result.stderr.toString();
  expect(stderr).toContain(
    "::warning::main/heavy failed only in advisory jobs",
  );
  expect(stderr).toContain(MARKETING_JOB);
  expect(stderr).toContain("actions/runs/2");
});

const refusedHeavy = (options: FailedHeavyOptions) => {
  const proof = failedHeavy(options);
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.result.stderr.toString()).toContain("RELEASE_HEAVY_NOT_GREEN");
  expect(proof.finalSha).toBeNull();
  expect(proof.pushes).toBe("");
  return proof;
};

test("a screenshot failure beside any other failed job still refuses", () => {
  const proof = refusedHeavy({
    jobs: [
      marketingJob(),
      heavyJob("suites / api-tests (2)", "failure"),
      ...ROLLUP_JOBS,
    ],
  });
  expect(proof.result.stderr.toString()).toContain("suites / api-tests (2)");
});

test("a screenshot failure beside a skipped planned required job refuses", () => {
  const proof = refusedHeavy({
    jobs: [marketingJob(), ...ROLLUP_JOBS],
    record: requiredRecord({
      required: [
        { job: "e2e-production-shard", conclusion: "skipped" },
        { job: "marketing-screenshots", conclusion: "failure" },
      ],
    }),
  });
  expect(proof.result.stderr.toString()).toContain(
    "e2e-production-shard (skipped)",
  );
});

test("a screenshot failure beside an unmet folded sub-suite refuses", () => {
  refusedHeavy({
    jobs: [marketingJob(), ...ROLLUP_JOBS],
    violations: requiredViolations({
      violations:
        "marketing-screenshots (planned, failure), api-image-deps (planned, failure)",
    }),
  });
});

test("an unreadable required-jobs record refuses", () => {
  refusedHeavy({ jobs: [marketingJob(), ...ROLLUP_JOBS], record: null });
});

test("an absent or unevaluated violations artifact refuses", () => {
  refusedHeavy({ jobs: [marketingJob(), ...ROLLUP_JOBS], violations: null });
  refusedHeavy({
    jobs: [marketingJob(), ...ROLLUP_JOBS],
    violations: requiredViolations({ evaluated: false }),
  });
});

test("a violations artifact of another run or commit refuses", () => {
  refusedHeavy({
    jobs: [marketingJob(), ...ROLLUP_JOBS],
    violations: requiredViolations({ run_id: HEAVY_RUN_ID + 1 }),
  });
  refusedHeavy({
    jobs: [marketingJob(), ...ROLLUP_JOBS],
    violations: requiredViolations({ head_sha: "f".repeat(40) }),
  });
});

test("a record of another commit refuses", () => {
  refusedHeavy({
    jobs: [marketingJob(), ...ROLLUP_JOBS],
    record: requiredRecord({ head_sha: "f".repeat(40) }),
  });
});

test("a failure in a seed or setup step of the screenshots job refuses", () => {
  refusedHeavy({
    jobs: [
      marketingJob([
        { name: "Set up job", conclusion: "success" },
        { name: CAPTURE_STEP, conclusion: "failure" },
        { name: MARKER_STEP, conclusion: "skipped" },
      ]),
      ...ROLLUP_JOBS,
    ],
  });
});

test("a job count different from total_count refuses", () => {
  refusedHeavy({ jobs: [marketingJob(), ...ROLLUP_JOBS], total: 4 });
});

test("a failure that only the aggregates report refuses", () => {
  refusedHeavy({ jobs: ROLLUP_JOBS });
});

test("a job name the advisory set does not know refuses", () => {
  refusedHeavy({
    jobs: [
      {
        ...marketingJob(),
        name: "suites / marketing-screenshots-v2 / check",
      },
      ...ROLLUP_JOBS,
    ],
  });
});

test("a cancelled advisory job or run refuses", () => {
  refusedHeavy({
    jobs: [{ ...marketingJob(), conclusion: "cancelled" }, ...ROLLUP_JOBS],
  });
  refusedHeavy({
    jobs: [marketingJob(), ...ROLLUP_JOBS],
    conclusion: "cancelled",
  });
});

test("an unfinished job beside the advisory failure refuses", () => {
  refusedHeavy({
    jobs: [marketingJob(), heavyJob("suites / e2e", null), ...ROLLUP_JOBS],
  });
});

test("an unreadable job list refuses", () => {
  refusedHeavy({ jobs: [] });
});
