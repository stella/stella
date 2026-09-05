import { describe, expect, test } from "bun:test";

import {
  checkResultBoundaryEnrolment,
  resultConventionUnit,
} from "./check-result-boundary-enrolment";

// One fixture tree standing in for the repository: an enabled app directory, an
// unenrolled one, an enabled package, and a test file that carries no debt.
const files = [
  "apps/shop/src/handlers/orders/create.ts",
  "apps/shop/src/handlers/orders/create.test.ts",
  "apps/shop/src/handlers/refunds/create.ts",
  "apps/shop/src/index.ts",
  "packages/money/src/nested/amount.ts",
  "README.md",
] as const;

const enabledGlobs = [
  "apps/shop/src/handlers/orders/**/*.ts",
  "packages/money/src/**/*.ts",
] as const;

const isExcluded = (file: string): boolean => file.endsWith(".test.ts");

const check = (optOuts: readonly { reason: string; unit: string }[]) =>
  checkResultBoundaryEnrolment({ enabledGlobs, files, isExcluded, optOuts });

const seeded = [
  { reason: "unreviewed", unit: "apps/shop/src" },
  { reason: "unreviewed", unit: "apps/shop/src/handlers/refunds" },
] as const;

describe("enrolment unit", () => {
  test("groups app source two levels under src", () => {
    expect(
      resultConventionUnit("apps/shop/src/handlers/orders/deep/a.ts"),
    ).toBe("apps/shop/src/handlers/orders");
    expect(resultConventionUnit("apps/shop/src/handlers/a.ts")).toBe(
      "apps/shop/src/handlers",
    );
    expect(resultConventionUnit("apps/shop/src/a.ts")).toBe("apps/shop/src");
  });

  test("groups package source at the src root", () => {
    expect(resultConventionUnit("packages/money/src/deep/nested/a.ts")).toBe(
      "packages/money/src",
    );
  });

  test("ignores paths outside workspace source", () => {
    expect(resultConventionUnit("scripts/ratchet.ts")).toBeUndefined();
    expect(resultConventionUnit("apps/shop/e2e/a.ts")).toBeUndefined();
  });
});

describe("result boundary enrolment", () => {
  test("accepts a tree where every directory is enabled or opted out", () => {
    const report = check(seeded);

    expect(report.errors).toEqual([]);
    expect(report.enabledUnits).toBe(2);
    expect(report.optedOutUnits).toBe(2);
  });

  test("fails a directory that is neither enabled nor opted out", () => {
    const report = check([seeded[0]]);

    expect(report.errors).toHaveLength(1);
    expect(report.errors.at(0)).toContain(
      "apps/shop/src/handlers/refunds: 1 of 1 source file(s)",
    );
  });

  test("fails a directory the enable list covers only in part", () => {
    const report = checkResultBoundaryEnrolment({
      enabledGlobs: ["apps/shop/src/handlers/orders/create.ts"],
      files: [
        "apps/shop/src/handlers/orders/create.ts",
        "apps/shop/src/handlers/orders/cancel.ts",
      ],
      isExcluded,
      optOuts: [],
    });

    expect(report.errors.at(0)).toContain(
      "apps/shop/src/handlers/orders: 1 of 2 source file(s)",
    );
  });

  test("fails an opt-out for a directory that is now enabled", () => {
    const report = check([
      ...seeded,
      { reason: "unreviewed", unit: "packages/money/src" },
    ]);

    expect(report.errors.at(0)).toContain(
      '"packages/money/src" is enabled, so its opt-out is stale',
    );
  });

  test("fails an opt-out that names no source directory", () => {
    const report = check([
      ...seeded,
      { reason: "unreviewed", unit: "apps/shop/src/handlers/gone" },
    ]);

    expect(report.errors.at(0)).toContain(
      'opt-out for "apps/shop/src/handlers/gone" names no source directory',
    );
  });

  test("fails an opt-out with a blank reason", () => {
    const report = check([
      seeded[0],
      { reason: "  ", unit: "apps/shop/src/handlers/refunds" },
    ]);

    expect(report.errors.at(0)).toContain(
      'opt-out for "apps/shop/src/handlers/refunds" has no reason',
    );
  });

  test("fails a duplicated opt-out", () => {
    const report = check([...seeded, seeded[1]]);

    expect(report.errors.at(0)).toContain(
      'duplicate opt-out for "apps/shop/src/handlers/refunds"',
    );
  });

  test("fails an enabled glob whose directory was removed", () => {
    const report = checkResultBoundaryEnrolment({
      enabledGlobs: [...enabledGlobs, "apps/shop/src/handlers/legacy/**/*.ts"],
      files,
      isExcluded,
      optOuts: seeded,
    });

    expect(report.errors).toHaveLength(1);
    expect(report.errors.at(0)).toContain(
      'enabled glob "apps/shop/src/handlers/legacy/**/*.ts" matches no source file',
    );
  });

  test("does not count an excluded file as a glob's only match", () => {
    const report = checkResultBoundaryEnrolment({
      enabledGlobs: ["apps/shop/src/handlers/orders/**/*.ts"],
      files: ["apps/shop/src/handlers/orders/create.test.ts"],
      isExcluded,
      optOuts: [],
    });

    expect(report.errors.at(0)).toContain(
      'enabled glob "apps/shop/src/handlers/orders/**/*.ts" matches no source file',
    );
  });

  test("ignores directories whose only files are excluded", () => {
    const report = checkResultBoundaryEnrolment({
      enabledGlobs: [],
      files: ["apps/shop/src/handlers/legacy/a.test.ts"],
      isExcluded,
      optOuts: [],
    });

    expect(report.errors).toEqual([]);
  });
});
