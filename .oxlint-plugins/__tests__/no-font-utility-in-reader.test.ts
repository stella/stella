import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-font-utility-in-reader";

setDefaultTimeout(20_000);

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "reader-surface.tsx" });

describe.serial(RULE_NAME, () => {
  test("reports a font family wherever the class string is written", async () => {
    const source = [
      `export const _a = () => <p className="font-sans text-xs" />;`,
      `export const _b = () => <span className={cn("font-serif", extra)} />;`,
      "export const _c = () => <div className={`md:font-mono`} />;",
      `export const HEADING = { 1: "font-sans text-lg" };`,
      // The `!` modifier and stacked variants are the same utility.
      `export const _d = () => <p className="group-hover:font-sans!" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5]);
  });

  test("accepts the named classes and utilities that name no family", async () => {
    const source = [
      `export const _a = () => <p className="reader-chrome text-xs" />;`,
      `export const _b = () => <span className="reader-body text-sm" />;`,
      `export const _c = () => <h1 className="text-xl font-semibold" />;`,
      `export const _d = () => <span className={cn("font-medium", extra)} />;`,
      // A CSS variable of the same name is a value, not a utility.
      `export const _e = () => <p style={{ fontFamily: "var(--font-sans)" }} />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
