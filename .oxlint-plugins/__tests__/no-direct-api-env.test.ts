import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("confines both API deployment bases including static bracket reads", async () => {
  expect(
    await lintSingleRule(
      "no-direct-api-env",
      'env.VITE_API_URL;\nenv.VITE_BROWSER_API_URL;\nenv["VITE_API_URL"];',
      { plugin: "no-raw-api-url" },
    ),
  ).toEqual([1, 2, 3]);
});

test("accepts deployment bases in their exact resolver: apps/web/src/env.ts", async () => {
  expect(
    await lintSingleRule(
      "no-direct-api-env",
      "env.VITE_API_URL;\nenv.VITE_BROWSER_API_URL;",
      { sourcePath: "apps/web/src/env.ts", plugin: "no-raw-api-url" },
    ),
  ).toEqual([]);
});

test("accepts deployment bases in their exact resolver: apps/web/src/lib/api-origins.ts", async () => {
  expect(
    await lintSingleRule(
      "no-direct-api-env",
      "env.VITE_API_URL;\nenv.VITE_BROWSER_API_URL;",
      {
        sourcePath: "apps/web/src/lib/api-origins.ts",
        plugin: "no-raw-api-url",
      },
    ),
  ).toEqual([]);
});

test("does not exempt same-basename non-owner modules", async () => {
  expect(
    await lintSingleRule("no-direct-api-env", "env.VITE_API_URL;", {
      sourcePath: "apps/web/src/components/api-origins.ts",
      plugin: "no-raw-api-url",
    }),
  ).toEqual([1]);
});

test("accepts resolver APIs and unrelated environment settings", async () => {
  expect(
    await lintSingleRule(
      "no-direct-api-env",
      'browserApiBaseUrl;\nexternalApiUrl("/entities");\nenv.VITE_DESKTOP_BRIDGE_URL;\nsettings.VITE_API_URL;',
      { plugin: "no-raw-api-url" },
    ),
  ).toEqual([]);
});
