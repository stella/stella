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
const heavyJob = (name: string, conclusion: string | null) => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
});
const ROLLUP_JOBS = [
  heavyJob("suites / ci-result", "failure"),
  heavyJob("status", "failure"),
];
const failedHeavy = (
  jobs: readonly ReturnType<typeof heavyJob>[],
  conclusion = "failure",
) =>
  finalize({
    states: { "main/heavy": "failure" },
    heavyRun: { conclusion, jobs },
  });

test("a heavy run that failed only in marketing screenshots finalizes with a warning", () => {
  const proof = failedHeavy([
    heavyJob("suites / web-tests", "success"),
    heavyJob(MARKETING_JOB, "failure"),
    ...ROLLUP_JOBS,
  ]);
  expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
  expect(proof.finalSha).toBe(proof.sha);
  const stderr = proof.result.stderr.toString();
  expect(stderr).toContain(
    "::warning::main/heavy failed only in advisory jobs",
  );
  expect(stderr).toContain(MARKETING_JOB);
  expect(stderr).toContain("actions/runs/2");
});

const refusedHeavy = (
  jobs: readonly ReturnType<typeof heavyJob>[],
  conclusion?: string,
) => {
  const proof = failedHeavy(jobs, conclusion);
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.result.stderr.toString()).toContain("RELEASE_HEAVY_NOT_GREEN");
  expect(proof.finalSha).toBeNull();
  expect(proof.pushes).toBe("");
  return proof;
};

test("a marketing screenshot failure beside any other failed job still refuses", () => {
  const proof = refusedHeavy([
    heavyJob(MARKETING_JOB, "failure"),
    heavyJob("suites / api-tests (2)", "failure"),
    ...ROLLUP_JOBS,
  ]);
  expect(proof.result.stderr.toString()).toContain("suites / api-tests (2)");
});

test("a failure that only the aggregates report refuses", () => {
  refusedHeavy(ROLLUP_JOBS);
});

test("a job name the advisory set does not know refuses", () => {
  refusedHeavy([
    heavyJob("suites / marketing-screenshots-v2 / check", "failure"),
    ...ROLLUP_JOBS,
  ]);
});

test("a cancelled advisory job or run refuses", () => {
  refusedHeavy([heavyJob(MARKETING_JOB, "cancelled"), ...ROLLUP_JOBS]);
  refusedHeavy(
    [heavyJob(MARKETING_JOB, "failure"), ...ROLLUP_JOBS],
    "cancelled",
  );
});

test("an unfinished job beside the advisory failure refuses", () => {
  refusedHeavy([
    heavyJob(MARKETING_JOB, "failure"),
    heavyJob("suites / e2e", null),
    ...ROLLUP_JOBS,
  ]);
});

test("an unreadable job list refuses", () => {
  refusedHeavy([]);
});
