import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { GUARD_ROLLOUTS } from "./guard-rollout-policy.ts";
import {
  changedLineNumbers,
  guardEnforcesLine as productionGuardEnforcesLine,
} from "./guard-rollouts.ts";

const guardEnforcesLine = (
  options: Parameters<typeof productionGuardEnforcesLine>[0],
) =>
  productionGuardEnforcesLine({
    ...options,
    rollouts: [
      {
        id: "portable-path",
        type: "changed-lines",
        expiresAt: "2026-10-20T00:00:00.000Z",
        check: ["bun", "scripts/check-fixture.ts"],
      },
      ...GUARD_ROLLOUTS.filter(({ id }) => id !== "portable-path"),
    ],
  });

test("diff scope excludes deletion hunks and includes every inserted line", () => {
  expect([
    ...changedLineNumbers("@@ -1,2 +1,0 @@\n@@ -8 +7,2 @@\n@@ -12 +13 @@"),
  ]).toEqual([7, 8, 13]);
});

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = ".oxlint-plugins/__fixtures__";
const fixtures = readdirSync(path.join(ROOT, FIXTURES), {
  encoding: "utf-8",
  recursive: true,
})
  .filter((name) => name.endsWith(".fixture.ts"))
  .map((name) => {
    const file = `${FIXTURES}/${name}`;
    return { file, source: readFileSync(path.join(ROOT, file), "utf-8") };
  });

for (const { id: guard, rules = [] } of GUARD_ROLLOUTS) {
  for (const rule of rules) {
    test(`${rule} enforces every violating fixture line without changed lines`, () => {
      let violations = 0;
      for (const { file, source } of fixtures) {
        for (const [index, line] of source.split("\n").entries()) {
          if (
            !line.includes("oxlint-disable-next-line") ||
            !line.includes(rule)
          ) {
            continue;
          }
          violations++;
          for (const fixturePath of [file, path.join(ROOT, file)]) {
            expect(
              guardEnforcesLine({
                guard,
                file: fixturePath,
                line: index + 2,
                now: new Date("2026-10-14T00:00:00.000Z"),
                changedLines: new Map(),
              }),
            ).toBe(true);
          }
        }
      }
      expect(violations).toBeGreaterThan(0);
    });
  }
}

test("fixture scope does not include similarly named directories", () => {
  expect(
    guardEnforcesLine({
      guard: "portable-path",
      file: `${FIXTURES}-other/path.ts`,
      line: 1,
      now: new Date("2026-10-14T00:00:00.000Z"),
      changedLines: new Map(),
    }),
  ).toBe(false);
});

test("first-week path enforcement ignores legacy lines and expires into full scope", () => {
  const changedLines = new Map([["scripts/path.ts", new Set([4])]]);
  const options = {
    guard: "portable-path",
    file: "scripts/path.ts",
    changedLines,
  };
  const now = new Date("2026-10-14T00:00:00.000Z");
  expect(guardEnforcesLine({ ...options, line: 3, now })).toBe(false);
  expect(guardEnforcesLine({ ...options, line: 4, now })).toBe(true);
  expect(
    guardEnforcesLine({
      ...options,
      line: 3,
      now: new Date("2026-10-20T00:00:00.000Z"),
    }),
  ).toBe(true);
});
