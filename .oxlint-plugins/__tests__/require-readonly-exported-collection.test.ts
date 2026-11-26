import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "require-readonly-exported-collection";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule(RULE, lines.join("\n"));

test("rejects exported module-level mutable Map and Set singletons", async () => {
  expect(
    await lint([
      "export const A = new Set(['x']);",
      "export const B = new Map<string, number>([['x', 1]]);",
      "const C = new Set(['y']);",
      "export { C };",
    ]),
  ).toEqual([1, 2, 3]);
});

test("allows ReadonlyMap/ReadonlySet exports and non-exported local collections", async () => {
  expect(
    await lint([
      "export const A: ReadonlySet<string> = new Set(['x']);",
      "export const B: ReadonlyMap<string, number> = new Map([['x', 1]]);",
      "const LOCAL = new Map<string, number>();",
      "export const read = (k: string) => LOCAL.get(k);",
    ]),
  ).toEqual([]);
});
