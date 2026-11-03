import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE_NAME = "no-sm-breakpoint-in-desktop";

const lint = async (source: string) =>
  await lintSingleRule(RULE_NAME, source, { sourcePath: "desktop-view.tsx" });

describe.serial(RULE_NAME, () => {
  test("reports `sm:` and `max-sm:` wherever a class string carries them", async () => {
    const source = [
      `export const _a = () => <div className="grid sm:grid-cols-3" />;`,
      `export const _b = () => <p className={cn("max-sm:hidden", extra)} />;`,
      "export const _c = () => <div className={`gap-2 sm:hover:bg-muted`} />;",
      `export const SIZE = { sm: "h-8 sm:h-7" };`,
      // A pin needs the bare utility; a different bare utility is no pin.
      `export const _d = () => <p className="text-sm sm:text-base" />;`,
      // `max-sm:` never pins: it never applies in a desktop window.
      `export const _e = () => <p className="pb-4 max-sm:pb-4" />;`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("accepts explicit widths, pinned sizes and lookalike names", async () => {
    const source = [
      `export const _a = () => <div className="grid min-[40rem]:grid-cols-3" />;`,
      `export const _b = () => <p className="max-[40rem]:hidden" />;`,
      `export const _c = () => <input className="h-11 text-base sm:text-base" />;`,
      `export const SIZES = { sm: "min-w-6 h-6 text-xs" };`,
      `export const _d = () => <Button size="sm" />;`,
      `export const LABEL = "sm: small";`,
      "",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
