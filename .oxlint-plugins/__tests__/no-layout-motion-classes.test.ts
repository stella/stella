import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-layout-motion-classes";

setDefaultTimeout(20_000);

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
  { allowedFiles, fileName = "motion-surface.tsx" }: LintOptions = {},
) =>
  await lintSingleRule(RULE_NAME, source, {
    sourcePath: fileName,
    ruleOptions: allowedFiles === undefined ? undefined : { allowedFiles },
  });

describe.serial(RULE_NAME, () => {
  test("reports motion and viewport utilities wherever the class string is written", async () => {
    const source = [
      `export const _a = () => <p className="transition-all duration-150" />;`,
      `export const _b = () => <span className={cn("min-h-screen", extra)} />;`,
      "export const _c = () => <div className={`md:transition-[height]`} />;",
      `export const PANEL = { wide: "w-screen max-h-screen" };`,
      // The `!` modifier and stacked variants are the same utility.
      `export const _d = () => <p className="group-hover:transition-all!" />;`,
      `export const _e = () => <p className="transition-[font-size]" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("exempts only the listed utility in the listed box-owning surface", async () => {
    const source = [
      `export const _a = () => <div className="w-(--rail) transition-[width]" />;`,
      `export const _b = () => <div className="h-(--panel) transition-[height]" />;`,
      "",
    ].join("\n");
    const allowedFiles = [
      {
        path: "collapsible-rail.tsx",
        reason: "Collapsible rail animates the width it owns.",
        utilities: ["transition-[width]"],
      },
    ] as const;

    expect(
      await lint(source, { allowedFiles, fileName: "collapsible-rail.tsx" }),
    ).toEqual([2]);
    expect(
      await lint(source, { allowedFiles, fileName: "ordinary-card.tsx" }),
    ).toEqual([1, 2]);
  });

  test("keeps transition-all and the viewport units reported in an allowed file", async () => {
    const source = [
      `export const _a = () => <div className="transition-[width] transition-all" />;`,
      `export const _b = () => <div className="transition-[height] min-h-screen" />;`,
      "",
    ].join("\n");

    expect(
      await lint(source, {
        allowedFiles: [
          {
            path: "collapsible-rail.tsx",
            reason: "Collapsible rail animates the width it owns.",
            utilities: ["transition-[width]"],
          },
        ],
        fileName: "collapsible-rail.tsx",
      }),
    ).toEqual([1, 2]);
  });

  test("accepts compositable motion and dynamic-viewport utilities", async () => {
    const source = [
      `export const _a = () => <p className="transition-opacity duration-150" />;`,
      `export const _b = () => <span className="transition-transform" />;`,
      `export const _c = () => <div className="transition-none" />;`,
      `export const _d = () => <section className={cn("min-h-dvh", extra)} />;`,
      `export const _e = () => <p className="h-dvh max-h-dvh w-dvw" />;`,
      `export const _f = () => <p className="animate-[pulse_700ms_ease-in-out_3]" />;`,
      // Arbitrary animation values name keyframes, not CSS properties. The
      // stylesheet rule checks what those keyframes animate.
      `export const _g = () => <p className="animate-[height_200ms_ease-out]" />;`,
      // A rounded corner names a physical side, not an animated layout property.
      `export const _h = () => <p className="animate-in rounded-tl-md" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
