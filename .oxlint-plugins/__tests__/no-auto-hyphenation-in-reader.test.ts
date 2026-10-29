import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-auto-hyphenation-in-reader";

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "reader-surface.tsx" });

describe.serial(RULE_NAME, () => {
  test("reports automatic hyphenation with variants and arbitrary properties", async () => {
    const source = [
      `export const _a = () => <p className="hyphens-auto" />;`,
      `export const _b = () => <p className={cn("md:hyphens-auto!", extra)} />;`,
      `export const _c = () => <p className="[hyphens:auto]" />;`,
      `export const _d = () => <p className="lg:[hyphens:auto]" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4]);
  });

  test("accepts manual and disabled hyphenation utilities", async () => {
    const source = [
      `export const _a = () => <p className="hyphens-manual" />;`,
      `export const _b = () => <p className="hyphens-none" />;`,
      `export const _c = () => <p className="[hyphens:manual]" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
