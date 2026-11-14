import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects serial lint awaits in loop bodies", async () => {
  expect(
    await lintSingleRule(
      "no-serial-lint-case",
      "async function run() { for (const item of cases) { await lintCase(item); } }",
    ),
  ).toEqual([1]);
});

test("allows concurrent cases, nested callbacks, and unrelated awaits", async () => {
  expect(
    await lintSingleRule(
      "no-serial-lint-case",
      [
        "async function concurrent() { await Promise.all(cases.map(async (item) => await lintCase(item))); }",
        "function deferred() { for (const item of cases) { callbacks.push(async () => await lintCase(item)); } }",
        "async function unrelated() { for (const item of cases) { await load(item); } }",
      ].join("\n"),
    ),
  ).toEqual([]);
});
