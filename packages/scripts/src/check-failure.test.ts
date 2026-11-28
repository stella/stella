import { expect, test } from "bun:test";

import {
  type CheckFailure,
  failCheck,
  formatCheckFailure,
} from "./check-failure";

test("formats a failure with a mechanical fix command", () => {
  expect(
    formatCheckFailure({
      check: "check-generated",
      summary: "Generated artifacts are out of date.",
      fixCommand: "bun run generate",
    }),
  ).toBe(
    [
      "[check-generated] Generated artifacts are out of date.",
      "Fix: bun run generate",
    ].join("\n"),
  );
});

test("formats a failure with human remediation, details, and rerun command", () => {
  expect(
    formatCheckFailure({
      check: "check-ci-job-names",
      summary: "2 CI job name issues found",
      details: ["job-a: unresolved name", "job-b: ambiguous name"],
      remediation: "Give each job a distinct static or literal-only name.",
      rerunCommand: "bun scripts/check-ci-job-names.ts",
    }),
  ).toBe(
    [
      "[check-ci-job-names] 2 CI job name issues found",
      "  - job-a: unresolved name",
      "  - job-b: ambiguous name",
      "Remediation: Give each job a distinct static or literal-only name.",
      "Re-run: bun scripts/check-ci-job-names.ts",
    ].join("\n"),
  );
});

test("supports both fixCommand and remediation together and omits empty details", () => {
  expect(
    formatCheckFailure({
      check: "check-lint",
      summary: "Lint violations found",
      details: [],
      fixCommand: "bun run lint:fix",
      remediation: "Resolve any remaining unfixable diagnostics manually.",
    }),
  ).toBe(
    [
      "[check-lint] Lint violations found",
      "Fix: bun run lint:fix",
      "Remediation: Resolve any remaining unfixable diagnostics manually.",
    ].join("\n"),
  );
});

test("failCheck writes a trailing newline and returns the failing exit code", () => {
  const chunks: string[] = [];
  const code = failCheck(
    {
      check: "check-pins",
      summary: "Unpinned action found",
      remediation: "Pin the action to a full 40-character commit SHA.",
    },
    {
      write: (text) => {
        chunks.push(text);
      },
    },
  );
  expect(code).toBe(1);
  expect(chunks.join("")).toBe(
    [
      "[check-pins] Unpinned action found",
      "Remediation: Pin the action to a full 40-character commit SHA.",
      "",
    ].join("\n"),
  );
});

test("type contract rejects check failures without fixCommand or remediation", () => {
  // Type-level check only: verifies the discriminated union requires remediation.
  const verifyTypes = (): CheckFailure =>
    // @ts-expect-error CheckFailure requires either fixCommand or remediation
    ({
      check: "check-bare",
      summary: "Bare failure without remediation",
    });
  expect(typeof verifyTypes).toBe("function");
});
