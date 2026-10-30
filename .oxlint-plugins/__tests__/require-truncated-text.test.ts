import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "require-truncated-text";

type LintOptions = {
  allowedFiles?: readonly {
    path: string;
    reason: string;
    utilities: readonly string[];
  }[];
  fileName?: string;
};

const lint = async (
  source: string,
  { allowedFiles, fileName = "matter-card.tsx" }: LintOptions = {},
) =>
  await lintSingleRule(RULE_NAME, source, {
    sourcePath: fileName,
    ruleOptions: allowedFiles === undefined ? undefined : { allowedFiles },
  });

describe.serial(RULE_NAME, () => {
  test("reports truncating utilities wherever the class string is written", async () => {
    const source = [
      `export const _a = () => <span className="truncate text-sm" />;`,
      `export const _b = () => <p className={cn("line-clamp-2", extra)} />;`,
      "export const _c = () => <div className={`sm:truncate`} />;",
      `export const ROW = { title: "overflow-hidden text-ellipsis whitespace-nowrap" };`,
      // The `!` modifier, stacked and arbitrary variants are the same utility.
      `export const _d = () => <p className="group-hover:truncate!" />;`,
      `export const _e = () => <div className="[&>span]:truncate" />;`,
      `export const _f = () => <span className="line-clamp-[7]" />;`,
      `export const _g = cva("flex", { variants: { size: { sm: "line-clamp-3" } } });`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("accepts the utilities that remove or clip without an ellipsis", async () => {
    const source = [
      `export const _a = () => <p className="line-clamp-none text-clip" />;`,
      `export const _b = () => <p className="md:line-clamp-none overflow-hidden" />;`,
      // Words that only contain the utility's name are not the utility.
      `export const _c = () => <p data-state="truncated" />;`,
      `export const _d = () => <p className="truncate-x line-clamp-x" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });

  test("exempts only the listed token in the listed primitive", async () => {
    const source = [
      `export const _a = () => <div className="[&>span:last-child]:truncate" />;`,
      `export const _b = () => <span className="truncate" />;`,
      `export const _c = () => <div className="[&>span]:truncate" />;`,
      "",
    ].join("\n");
    const allowedFiles = [
      {
        path: "sidebar.tsx",
        reason: "Menu buttons style the label span their callers render.",
        utilities: ["[&>span:last-child]:truncate"],
      },
    ] as const;

    expect(
      await lint(source, { allowedFiles, fileName: "sidebar.tsx" }),
    ).toEqual([2, 3]);
    expect(
      await lint(source, { allowedFiles, fileName: "ordinary-card.tsx" }),
    ).toEqual([1, 2, 3]);
  });

  test("leaves the component that implements truncation alone", async () => {
    const source = [
      `const LINES = { 1: "block min-w-0 max-w-full truncate", 2: "line-clamp-2" };`,
      "export { LINES };",
      "",
    ].join("\n");

    expect(
      await lint(source, {
        fileName: "packages/ui/src/components/truncated-text.tsx",
      }),
    ).toEqual([]);
    expect(await lint(source, { fileName: "truncated-label.tsx" })).toEqual([
      1,
    ]);
  });
});
