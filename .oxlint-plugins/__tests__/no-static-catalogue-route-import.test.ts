import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects catalogue value imports in the configured Tools shell", async () => {
  expect(
    await lintSingleRule(
      "no-static-catalogue-route-import",
      'import CatalogueBrowser from "@/routes/knowledge/-components/catalogue/catalogue-browser";',
      {
        sourcePath: "apps/web/src/routes/tools.tsx",
        ruleOptions: { routeFiles: ["apps/web/src/routes/tools.tsx"] },
      },
    ),
  ).toEqual([1]);
});

test("rejects relative catalogue value imports in the guarded shell", async () => {
  expect(
    await lintSingleRule(
      "no-static-catalogue-route-import",
      'import { CatalogueBrowser } from "./catalogue/catalogue-browser";',
      {
        sourcePath: "apps/web/src/routes/tools.tsx",
        ruleOptions: { routeFiles: ["apps/web/src/routes/tools.tsx"] },
      },
    ),
  ).toEqual([1]);
});

test("accepts erased catalogue type imports", async () => {
  expect(
    await lintSingleRule(
      "no-static-catalogue-route-import",
      'import type { CatalogueProps } from "@/routes/knowledge/-components/catalogue/catalogue-browser";\nimport { type CatalogueEntry } from "./catalogue/catalogue-browser";',
      {
        sourcePath: "apps/web/src/routes/tools.tsx",
        ruleOptions: { routeFiles: ["apps/web/src/routes/tools.tsx"] },
      },
    ),
  ).toEqual([]);
});

test("accepts the catalogue behind a lazy import callback", async () => {
  expect(
    await lintSingleRule(
      "no-static-catalogue-route-import",
      'const CatalogueBrowser = lazy(() => import("@/routes/knowledge/-components/catalogue/catalogue-browser"));',
      {
        sourcePath: "apps/web/src/routes/tools.tsx",
        ruleOptions: { routeFiles: ["apps/web/src/routes/tools.tsx"] },
      },
    ),
  ).toEqual([]);
});

test("accepts catalogue imports outside the guarded route shell", async () => {
  expect(
    await lintSingleRule(
      "no-static-catalogue-route-import",
      'import CatalogueBrowser from "@/routes/knowledge/-components/catalogue/catalogue-browser";',
      {
        sourcePath: "apps/web/src/routes/knowledge.tsx",
        ruleOptions: { routeFiles: ["apps/web/src/routes/tools.tsx"] },
      },
    ),
  ).toEqual([]);
});
