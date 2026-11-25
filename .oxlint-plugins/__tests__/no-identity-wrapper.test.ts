import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "no-identity-wrapper";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule(RULE, lines.join("\n"));

test("rejects a pass-through identity wrapper that is called directly", async () => {
  expect(
    await lint([
      "const defineMap = <const T extends Record<string, string>>(x: T): T => x;",
      "function wrap<T>(x: T): T { return x; }",
      "export const A = defineMap({ a: '1' });",
      "export const B = wrap(42);",
    ]),
  ).toEqual([1, 2]);
});

test("allows identity callbacks passed by reference and non-identity helpers", async () => {
  expect(
    await lint([
      "const identity = (x: string): string => x;",
      "const trim = (x: string): string => x.trim();",
      "export const strategies = { identity, trim };",
      "export const cleaned = trim(' hi ');",
    ]),
  ).toEqual([]);
});
