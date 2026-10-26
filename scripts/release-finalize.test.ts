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
test("a missing RC or existing final receipt performs no writes", () => {
  for (const fixture of [{ noRc: true }, { replay: true }]) {
    const proof = finalize(fixture);
    expect(proof.result.exitCode, proof.result.stderr.toString()).toBe(0);
    expect(proof.pushes).toBe("");
    expect(proof.publications).toBe("");
  }
});
