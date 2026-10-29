import { describe, expect, test } from "bun:test";

import { appearanceTokens } from "../plain-button-placement-only.ts";
import { runSingleRule } from "./lint-single-rule.ts";

const RULE = "plain-button-placement-only";

const lint = async (source: string): Promise<number[]> =>
  (await runSingleRule(RULE, source, { sourcePath: "surface.tsx" })).lines;

describe("plain-button-placement-only", () => {
  test.concurrent("reports appearance on a plain button", async () => {
    const source = [
      'export const a = <Button variant="plain" className="flex rounded-md px-2" />;',
      'export const b = <Button variant="plain" className="hover:bg-muted w-full" />;',
      'export const c = <Button variant="plain" className={cn("flex", on && "text-primary")} />;',
      'export const d = <Button variant={on ? "plain" : "ghost"} className="ring-1" />;',
      // A template literal's text around a substitution (split so no linter
      // reads this string as a misplaced template).
      'export const e = <Button variant="plain" className={`block $' +
        "{x} shadow-xs`} />;",
      'export const f = <Button variant="plain" className={cn({ "font-medium": on })} />;',
      'export const g = <Button variant="plain" className="[mask-image:none]" />;',
    ].join("\n");
    expect(await lint(source)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test.concurrent(
    "leaves placement, other variants and other components alone",
    async () => {
      const source = [
        'export const a = <Button variant="plain" className="flex w-full min-w-0" />;',
        'export const b = <Button variant="plain" className="absolute inset-0 z-10 -translate-x-1/2" />;',
        'export const c = <Button variant="plain" className="pointer-coarse:min-h-11 group/row cursor-zoom-in" />;',
        'export const d = <Button variant="plain" className="before:absolute before:-inset-2 before:content-[\'\']" />;',
        'export const e = <Button variant="ghost" className="rounded-md px-2" />;',
        'export const f = <Card variant="plain" className="rounded-md px-2" />;',
        'export const g = <Button variant="plain" className={rowClassName} />;',
        'export const h = <Button variant="plain" />;',
        'export const i = <Button variant="plain" className="opacity-0 group-hover:opacity-100 transition-opacity" />;',
      ].join("\n");
      expect(await lint(source)).toEqual([]);
    },
  );
});

describe("appearanceTokens", () => {
  test("keeps variants and drops placement", () => {
    expect(
      appearanceTokens(
        "sm:flex hover:bg-muted !mt-2 -mx-1 data-[open]:hidden text-xs p-2 border",
      ),
    ).toEqual(["hover:bg-muted", "text-xs", "p-2", "border"]);
  });
});
