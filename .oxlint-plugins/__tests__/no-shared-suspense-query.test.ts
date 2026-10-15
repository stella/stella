import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects aliased and namespace suspense query calls in shared chrome", async () => {
  expect(
    await lintSingleRule(
      "no-shared-suspense-query",
      [
        'import { useSuspenseQuery as suspended } from "@tanstack/react-query";',
        "suspended(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useSuspenseQuery(options);",
      ].join("\n"),
    ),
  ).toEqual([2, 4]);
});

test("allows explicit loading queries and unrelated suspense functions", async () => {
  expect(
    await lintSingleRule(
      "no-shared-suspense-query",
      [
        'import { useQuery } from "@tanstack/react-query";',
        "useQuery(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useQuery(options);",
        'const useSuspenseQuery = () => "local";',
        "useSuspenseQuery();",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("allows explicitly exempt route content", async () => {
  expect(
    await lintSingleRule(
      "no-shared-suspense-query",
      [
        'import { useSuspenseQuery as suspended } from "@tanstack/react-query";',
        "suspended(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useSuspenseQuery(options);",
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
      "no-shared-suspense-query",
      [
        'import { useSuspenseQuery as suspended } from "@tanstack/react-query";',
        "suspended(options);",
        'import * as queries from "@tanstack/react-query";',
        "queries.useSuspenseQuery(options);",
      ].join("\n"),
      {
        sourcePath: "apps/web/src/components/report.tsx",
        ruleOptions: { allowedFiles: ["apps/web/src/routes/report.tsx"] },
      },
    ),
  ).toEqual([2, 4]);
});
