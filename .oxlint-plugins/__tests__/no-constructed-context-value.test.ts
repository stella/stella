import { expect, test } from "bun:test";

import config from "../../oxlint.config.ts";
import {
  readScopes,
  scopeMatches,
} from "../../scripts/oxlint-config-scopes.ts";
import reactCompilerBailouts from "../../scripts/react-compiler-bailouts.json" with { type: "json" };
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-constructed-context-value";
const RULE_ID = `${RULE}/${RULE}`;

const lint = async (source: string, ruleOptions?: unknown) =>
  await lintSingleRule(RULE, source, {
    sourcePath: "packages/ui/src/components/provider.tsx",
    ...(ruleOptions === undefined ? {} : { ruleOptions }),
  });

/** The setting the production config gives the rule for `file`. */
const settingFor = (file: string): unknown => {
  let setting: unknown;
  for (const scope of readScopes(config)) {
    if (scopeMatches(scope, file) && Object.hasOwn(scope.rules, RULE_ID)) {
      setting = scope.rules[RULE_ID];
    }
  }
  return setting;
};

test("rejects values built in render for every provider form", async () => {
  expect(
    await lint(
      [
        'import { createContext } from "react";',
        'import { ThemeContext, Tabs } from "./contexts";',
        "const Local = createContext(null);",
        "export const A = ({ theme, open }) => {",
        "  const value = { theme };",
        "  const list = [theme];",
        "  function onOpen() {}",
        "  return (",
        "    <>",
        "      <ThemeContext value={{ theme }} />",
        "      <ThemeContext.Provider value={value} />",
        "      <Local value={list} />",
        "      <Tabs.ListContext value={onOpen} />",
        "      <ThemeContext value={open ? { theme } : null} />",
        "      <ThemeContext value={() => theme} />",
        "      <ThemeContext value={<span />} />",
        "    </>",
        "  );",
        "};",
      ].join("\n"),
    ),
  ).toEqual([10, 11, 12, 13, 14, 15, 16]);
});

test("allows memoized, module-scope and passed-through values", async () => {
  expect(
    await lint(
      [
        'import { useMemo } from "react";',
        'import { ThemeContext, Select } from "./contexts";',
        "const STATIC = { theme: 'light' };",
        "export const A = ({ theme, value: given }) => {",
        "  const value = useMemo(() => ({ theme }), [theme]);",
        "  const read = readTheme(theme);",
        "  return (",
        "    <>",
        "      <ThemeContext value={value} />",
        "      <ThemeContext value={STATIC} />",
        "      <ThemeContext value={given} />",
        "      <ThemeContext value={read} />",
        "      <ThemeContext value={theme} />",
        "      <Select value={{ theme }} />",
        "    </>",
        "  );",
        "};",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("with `functions`, reports only inside the listed functions' outermost function", async () => {
  const source = [
    'import { ThemeContext } from "./contexts";',
    "export const Bailed = ({ theme }) => {",
    "  const Row = () => <ThemeContext value={{ theme }} />;",
    "  return <ThemeContext value={{ theme }}>{Row()}</ThemeContext>;",
    "};",
    "export const useInner = () => {",
    "  const nested = () => null;",
    "  return <ThemeContext value={{}} />;",
    "};",
    "export const Compiled = ({ theme }) => <ThemeContext value={{ theme }} />;",
  ].join("\n");
  expect(await lint(source, { functions: ["Bailed"] })).toEqual([3, 4]);
  // A bailout recorded on a nested function covers its whole hook.
  expect(await lint(source, { functions: ["nested"] })).toEqual([8]);
  expect(await lint(source, { functions: ["<module-transform>"] })).toEqual([
    3, 4, 8, 10,
  ]);
  expect(await lint(source)).toEqual([3, 4, 8, 10]);
});

test("the production config covers uncompiled sources and compiler bailouts", () => {
  expect(settingFor("packages/ui/src/components/sidebar.tsx")).toBe("error");
  expect(settingFor("apps/outlook/src/taskpane/app.tsx")).toBe("error");
  expect(settingFor("apps/landing/src/components/react/demo.tsx")).toBe(
    "error",
  );
  expect(settingFor("packages/ui/src/components/sidebar.test.tsx")).toBe(
    undefined,
  );
  expect(settingFor("apps/web/src/components/compiled-panel.tsx")).toBe(
    undefined,
  );

  const bailout = Object.keys(reactCompilerBailouts).find((key) =>
    key.startsWith("apps/web/src/"),
  );
  const [file = "", name = ""] = (bailout ?? "").split("::");
  const setting = settingFor(file);
  expect(Array.isArray(setting)).toBe(true);
  expect(setting).toContainEqual({
    functions: expect.arrayContaining([name]),
  });
});
