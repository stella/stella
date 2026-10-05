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
    "keys.toSorted(compareCodeUnit);",
    "",
  ].join("\n");
  const options = { sourcePath: "scripts/sort-keys.ts" };
  expect(
    await lintSingleRule("require-cached-collator", source, options),
  ).toEqual([3, 4]);
  expect(
    await lintSingleRule(
      "require-cached-collator",
      "declare const keys: string[];\nkeys.toSorted();\n",
      options,
    ),
  ).toEqual([]);
});

test("the rule is on for repository and API scripts", () => {
  const enabledFor = (file: string) =>
    readScopes(config)
      .filter((scope) => RULE_ID in scope.rules && scopeMatches(scope, file))
      .map((scope) => !ruleIsOff(scope.rules[RULE_ID]))
      .at(-1) ?? false;
  expect(enabledFor("scripts/ratchet.ts")).toBe(true);
  expect(enabledFor("scripts/lib/nested.test.ts")).toBe(true);
  expect(enabledFor("apps/api/scripts/lib/capability-catalog.ts")).toBe(true);
});
