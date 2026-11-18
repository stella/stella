import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  await lintSingleRule("no-manual-memo", source);

describe("manual memoization in compiled files", () => {
  test("rejects React's memo hooks through every import form", async () => {
    expect(
      await lint(
        [
          'import React, { useMemo, useCallback as stable } from "react";',
          'import * as R from "react";',
          "const a = useMemo(() => 1, []);",
          "const b = stable(() => 1, []);",
          "const c = React.useMemo(() => 1, []);",
          "const d = R.useCallback(() => 1, []);",
        ].join("\n"),
      ),
    ).toEqual([3, 4, 5, 6]);
  });

  test("rejects memo directives in functions and modules", async () => {
    expect(
      await lint(
        [
          '"use no forget";',
          "export function A() {",
          '  "use memo";',
          "  return null;",
          "}",
          "export const B = () => {",
          '  "use no memo";',
          "  return null;",
          "};",
        ].join("\n"),
      ),
    ).toEqual([1, 3, 7]);
  });

  test("accepts plain values, other modules' hooks, and directive-like strings", async () => {
    expect(
      await lint(
        [
          'import { useMemo } from "./local-memo";',
          "const useCallback = (fn: () => void) => fn;",
          "const a = useMemo(() => 1, []);",
          "const b = useCallback(() => undefined);",
          "const c = [1, 2].toSorted();",
          'const label = "use memo";',
          "export function C() {",
          '  consume("use no memo");',
          "  return null;",
          "}",
          "declare const consume: (value: unknown) => void;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
