import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects eager devtools package loads", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import { ReactQueryDevtools } from "@tanstack/react-query-devtools";\nconst router = require("@tanstack/react-router-devtools");\nexport * from "@tanstack/react-table-devtools";',
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects statically importing a devtools island into a route", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import Devtools from "../components/tanstack-devtools-root";',
      { cwd: "scratch", sourcePath: "apps/web/src/routes/example.tsx" },
    ),
  ).toEqual([1]);
});

test("allows type-only and lazy devtools loads", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import type { ReactQueryDevtools } from "@tanstack/react-query-devtools";\nconst query = import("@tanstack/react-query-devtools");\nconst island = import("../components/tanstack-devtools-root");',
      { cwd: "scratch", sourcePath: "apps/web/src/routes/example.tsx" },
    ),
  ).toEqual([]);
});

test("allows devtools package loads inside the lazy island owner", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import { ReactQueryDevtools } from "@tanstack/react-query-devtools";',
      {
        cwd: "scratch",
        sourcePath: "apps/web/src/components/tanstack-devtools-root.tsx",
      },
    ),
  ).toEqual([]);
});

test("keeps copies of the devtools owner restricted", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import { ReactQueryDevtools } from "@tanstack/react-query-devtools";',
      {
        cwd: "scratch",
        sourcePath: "apps/web/src/components/tanstack-devtools-root.copy.tsx",
      },
    ),
  ).toEqual([1]);
});

test("allows table devtools inside the table island", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import { ReactTableDevtools } from "@tanstack/react-table-devtools";',
      {
        cwd: "scratch",
        sourcePath:
          "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools.tsx",
      },
    ),
  ).toEqual([]);
});

test("keeps non-table devtools packages outside the table island", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import { ReactQueryDevtools } from "@tanstack/react-query-devtools";',
      {
        cwd: "scratch",
        sourcePath:
          "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools.tsx",
      },
    ),
  ).toEqual([1]);
});

test("keeps the owner basename restricted in another directory", async () => {
  expect(
    await lintSingleRule(
      "no-static-devtools-import",
      'import { ReactQueryDevtools } from "@tanstack/react-query-devtools";',
      {
        cwd: "scratch",
        sourcePath: "apps/web/src/other/tanstack-devtools-root.tsx",
      },
    ),
  ).toEqual([1]);
});
