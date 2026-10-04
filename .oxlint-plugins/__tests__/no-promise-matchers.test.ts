import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (...lines: readonly string[]) =>
  await lintSingleRule("no-promise-matchers", [...lines, ""].join("\n"), {
    plugin: "bun-test-hygiene",
    sourcePath: "suite.test.ts",
  });

describe.serial("no-promise-matchers", () => {
  test("reports rejects and resolves matchers on a bun:test expectation", async () => {
    expect(
      await lint(
        'import { expect } from "bun:test";',
        "declare const pending: Promise<number>;",
        'export const rejected = expect(pending).rejects.toThrow("boom");',
        "export const resolved = expect(pending).resolves.toBe(1);",
        "export const negated = expect(pending).not.resolves.toBe(2);",
      ),
    ).toEqual([3, 4, 5]);
  });

  test("accepts an awaited value and another framework's expect", async () => {
    expect(
      await lint(
        'import { expect } from "bun:test";',
        "declare const pending: Promise<number>;",
        "declare const otherExpect: (value: unknown) => {",
        "  rejects: { toThrow: () => Promise<void> };",
        "};",
        "export const awaited = async () => expect(await pending).toBe(1);",
        "export const other = otherExpect(pending).rejects.toThrow();",
      ),
    ).toEqual([]);
  });
});
