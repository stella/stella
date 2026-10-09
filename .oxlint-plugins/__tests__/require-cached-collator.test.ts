import { expect, test } from "bun:test";

import config from "../../oxlint.config.ts";
import {
  readScopes,
  ruleIsOff,
  scopeMatches,
} from "../../scripts/oxlint-config-scopes.ts";
import { lintSingleRule } from "./lint-single-rule";

const RULE_ID = "require-cached-collator/require-cached-collator";

test("bare localeCompare is reported; the shared comparators are not", async () => {
  const source = [
    "declare const keys: string[];",
    "declare const compareCodeUnit: (a: string, b: string) => number;",
    "keys.toSorted((a, b) => a.localeCompare(b));",
    'keys.toSorted((a, b) => a.localeCompare(b, "cs"));',
    'const collator = new Intl.Collator("cs");',
    'const callableCollator = Intl.Collator("cs");',
    "declare const cachedCollator: Intl.Collator;",
    "keys.toSorted(cachedCollator.compare);",
    "keys.toSorted(compareCodeUnit);",
    "",
  ].join("\n");
  const options = { sourcePath: "scripts/sort-keys.ts" };
  expect(
    await lintSingleRule("require-cached-collator", source, options),
  ).toEqual([3, 4, 5, 6]);
  expect(
    await lintSingleRule(
      "require-cached-collator",
      "declare const keys: string[];\nkeys.toSorted();\n",
      options,
    ),
  ).toEqual([]);
});

test("the rule is on for repository scripts, API scripts, and packages", () => {
  const enabledFor = (file: string) =>
    readScopes(config)
      .filter((scope) => RULE_ID in scope.rules && scopeMatches(scope, file))
      .map((scope) => !ruleIsOff(scope.rules[RULE_ID]))
      .at(-1) ?? false;
  expect(enabledFor("scripts/ratchet.ts")).toBe(true);
  expect(enabledFor("scripts/lib/nested.test.ts")).toBe(true);
  expect(enabledFor("apps/api/scripts/lib/capability-catalog.ts")).toBe(true);
  expect(enabledFor("packages/infosoud/src/format.ts")).toBe(true);
});
