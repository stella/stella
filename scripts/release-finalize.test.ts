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

const heavyJob = (name: string, conclusion: string) => ({
  name,
  status: "completed",
  conclusion,
});

// The screenshots job fails only on a functional capture failure (a
// difference alone passes it with a warning), so it blocks like any job.
test("a heavy run that failed only in marketing screenshots creates no final tag or publication", () => {
  const proof = finalize({
    states: { "main/heavy": "failure" },
    heavyRun: {
      conclusion: "failure",
      jobs: [
        heavyJob("suites / web-tests", "success"),
        heavyJob("suites / marketing-screenshots / check", "failure"),
        heavyJob("suites / ci-result", "failure"),
        heavyJob("status", "failure"),
      ],
    },
  });
  expect(proof.result.exitCode).not.toBe(0);
  expect(proof.result.stderr.toString()).toContain(
    "RELEASE_HEAVY_NOT_GREEN: trusted main/heavy success is required",
  );
  expect(proof.result.stderr.toString()).not.toContain("::warning::");
  expect(proof.finalSha).toBeNull();
  expect(proof.pushes).toBe("");
  expect(proof.publications).toBe("");
});
