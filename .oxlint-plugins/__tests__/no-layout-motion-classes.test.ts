import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-layout-motion-classes";

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

  test("reports large-viewport lengths inside arbitrary values", async () => {
    const source = [
      `export const _a = () => <div className="max-h-[calc(100vh-3rem)]" />;`,
      `export const _b = () => <div className={cn("max-h-[70vh]", extra)} />;`,
      `export const _c = () => <div className="max-h-[min(18rem,60vh)]" />;`,
      `export const _d = () => <div className="md:pt-[10.5vh]" />;`,
      `export const _e = () => <div className="max-h-[70dvh] pt-[8svh] h-[50lvh]" />;`,
      `export const _f = () => <div className="max-h-[min(18rem,60dvh)] w-[calc(100vw-2rem)]" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4]);
  });

  test("reports ease-in, an entry from scale-0, and UI durations above 300ms", async () => {
    const source = [
      `export const _a = () => <div className="transition-opacity ease-in" />;`,
      `export const _b = () => <div className="data-starting-style:scale-0" />;`,
      `export const _c = () => <div className="starting:scale-x-0" />;`,
      `export const _d = () => <div className="scale-[0]" />;`,
      `export const _e = () => <div className="transition-opacity duration-500" />;`,
      `export const _f = () => <div className="duration-[400ms]" />;`,
      `export const _g = () => <div className="duration-[0.35s]" />;`,
      `export const _h = () => <div className="ease-out ease-in-out ease-linear" />;`,
      `export const _i = () => <div className="duration-300 duration-[250ms] duration-[0.2s] duration-0" />;`,
      `export const _j = () => <div className="scale-95 data-starting-style:scale-98 scale-100" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("reports the hover: none media query and accepts pointer-coarse", async () => {
    const source = [
      `export const _a = () => <div className="opacity-0 [@media(hover:none)]:opacity-100" />;`,
      `export const _b = () => <div className="[@media(any-hover:none)]:block" />;`,
      `export const _c = () => <div className="[@media(hover:_none)]:block" />;`,
      `export const _d = () => <div className="opacity-0 pointer-coarse:opacity-100 [@media(hover:hover)]:block" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3]);
  });

  test("recognises integer, decimal and fractional duration units", async () => {
    const source = [
      `export const _a = () => <div className="duration-[301ms]" />;`,
      `export const _aa = () => <div className="duration-[301.5ms]" />;`,
      `export const _ab = () => <div className="duration-[.301s]" />;`,
      `export const _ac = () => <div className="duration-[1s]" />;`,
      `export const _b = () => <div className="duration-[300ms] duration-[300.0ms] duration-[.3s] duration-[0.3s]" />;`,
      `export const _c = () => <div className="duration-[1.s] duration-[1..5s] duration-[ms]" />;`,
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4]);
  });

  test("exempts a listed long duration but not a different one in the same file", async () => {
    const source = [
      `export const _a = () => <canvas className="transition-opacity duration-700" />;`,
      `export const _b = () => <div className="transition-opacity duration-1000" />;`,
      `export const _c = () => <div className="ease-in" />;`,
      "",
    ].join("\n");
    const allowedFiles = [
      {
        path: "globe.tsx",
        reason: "Decorative canvas fades in once after it draws.",
        utilities: ["duration-700"],
      },
    ] as const;

    expect(await lint(source, { allowedFiles, fileName: "globe.tsx" })).toEqual(
      [2, 3],
    );
  });

  test("keeps a viewport length reported even when it is listed", async () => {
    const source = [
      `export const _a = () => <div className="max-h-[70vh]" />;`,
      "",
    ].join("\n");

    expect(
      await lint(source, {
        allowedFiles: [
          {
            path: "dialog.tsx",
            reason: "A viewport unit is never a property of the surface.",
            utilities: ["max-h-[70vh]"],
          },
        ],
        fileName: "dialog.tsx",
      }),
    ).toEqual([1]);
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
