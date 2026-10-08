import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const sourcePath = ".oxlint-plugins/__fixtures__/outbound-owner.ts";

test("checks dynamic destinations through the current relative fetch owner", async () => {
  expect(
    await lintSingleRule(
      "require-safe-outbound-target",
      [
        'import { fetchWithTimeout as request } from "../../packages/fetch/src/index.ts";',
        "await request(inputUrl, { timeoutMs: 1000 });",
      ].join("\n"),
      { sourcePath, cwd: "scratch" },
    ),
  ).toEqual([2]);
});

test("accepts proven destinations through the current relative fetch owner", async () => {
  expect(
    await lintSingleRule(
      "require-safe-outbound-target",
      [
        'import * as http from "../../packages/fetch/src/index.ts";',
        'await http.fetchWithTimeout("https://api.example.com/items", { timeoutMs: 1000 });',
      ].join("\n"),
      { sourcePath, cwd: "scratch" },
    ),
  ).toEqual([]);
});
