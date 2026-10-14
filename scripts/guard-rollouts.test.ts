import { expect, test } from "bun:test";

import { changedLineNumbers, guardEnforcesLine } from "./guard-rollouts.ts";

test("diff scope excludes deletion hunks and includes every inserted line", () => {
  expect([
    ...changedLineNumbers("@@ -1,2 +1,0 @@\n@@ -8 +7,2 @@\n@@ -12 +13 @@"),
  ]).toEqual([7, 8, 13]);
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
