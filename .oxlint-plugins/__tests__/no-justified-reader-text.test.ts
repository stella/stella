import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-justified-reader-text";

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "reader-surface.tsx" });

describe.serial(RULE_NAME, () => {
  test("reports justified text wherever the alignment is written", async () => {
    const source = [
      `export const _a = () => <p className="text-justify text-xs" />;`,
      `export const _b = () => <span className={cn("lg:text-justify", extra)} />;`,
      "export const _c = () => <div className={`md:text-justify!`} />;",
      `export const ROLE_CLASS = { body: "text-justify hyphens-auto" };`,
      `export const _d = () => <p style={{ textAlign: "justify" }} />;`,
      `export const _e = () => <p style={{ "textAlignLast": "justify" }} />;`,
      `export const CSS = "p { text-align: justify; }";`,
      "export const LAST = `p { text-align-last:justify }`;",
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("accepts start alignment, other alignments and layout justification", async () => {
    const source = [
      `export const _a = () => <p className="reader-prose" />;`,
      `export const _b = () => <p className="text-center text-end" />;`,
      `export const _c = () => <div className="flex justify-between justify-self-start" />;`,
      `export const _d = () => <p style={{ textAlign: "start" }} />;`,
      // A property of another name keeps its value.
      `export const _e = () => <div style={{ justifyContent: "justify" }} />;`,
      `export const LABEL = "justify";`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
