import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects aliased and namespace bare queries in persistent chrome", async () => {
  expect(
    await lintSingleRule(
      "no-bare-chrome-query",
      [
        'import { useQuery as query } from "@tanstack/react-query";',
        "query(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useQuery(options);",
      ].join("\n"),
    ),
  ).toEqual([2, 4]);
});

test("allows deferred chrome hooks and unrelated query functions", async () => {
  expect(
    await lintSingleRule(
      "no-bare-chrome-query",
      [
        'import { useChromeQuery } from "@/hooks/use-chrome-query";',
        "useChromeQuery(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useQueryClient();",
        'const useQuery = () => "local";',
        "useQuery();",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("allows explicitly exempt route content", async () => {
  expect(
    await lintSingleRule(
      "no-bare-chrome-query",
      [
        'import { useQuery as query } from "@tanstack/react-query";',
        "query(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useQuery(options);",
      ].join("\n"),
      {
        sourcePath: "apps/web/src/routes/report.tsx",
        ruleOptions: { allowedFiles: ["apps/web/src/routes/report.tsx"] },
      },
    ),
  ).toEqual([]);
});

test("keeps matching basenames outside an exempt route restricted", async () => {
  expect(
    await lintSingleRule(
      "no-bare-chrome-query",
      [
        'import { useQuery as query } from "@tanstack/react-query";',
        "query(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useQuery(options);",
      ].join("\n"),
      {
        sourcePath: "apps/web/src/components/report.tsx",
        ruleOptions: { allowedFiles: ["apps/web/src/routes/report.tsx"] },
      },
    ),
  ).toEqual([2, 4]);
});
