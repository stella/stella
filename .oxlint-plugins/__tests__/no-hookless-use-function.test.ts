import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  await lintSingleRule("no-hookless-use-function", source);

describe("hook-named functions call a hook", () => {
  test("rejects declarations, arrows and function expressions that call no hook", async () => {
    expect(
      await lint(
        [
          "function useLabel(count) { return String(count); }",
          "const useOptions = () => ({ retry: false });",
          "const useLegacy = function () { return format(1); };",
          "const useWrapped = (() => 2) as () => number;",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  test("ignores hook calls that run in a nested callback", async () => {
    expect(
      await lint(
        [
          "const useReader = () => () => useStore();",
          "function useLater() { return { read() { return useStore(); } }; }",
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  test("accepts direct, member and React 19 `use` hook calls", async () => {
    expect(
      await lint(
        [
          "function useLabel() { const t = useTranslations(); return t('label'); }",
          "const useCount = () => React.useState(0);",
          "const useTheme = () => use(ThemeContext);",
          "const useGuarded = (enabled) => { if (enabled) {} return useStore(); };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("leaves non-hook names, non-function initialisers and overloads alone", async () => {
    expect(
      await lint(
        [
          "const formatLabel = (count) => String(count);",
          "const user = () => 1;",
          "const useStore = create(() => ({}));",
          "function useOverloaded(value: string): string;",
          "function useOverloaded(value: unknown) { return useStore(value); }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
