import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const source =
  'import { TooltipProvider } from "@stll/ui/tooltip";\nexport const App = () => <TooltipProvider />;';

test("reports TooltipProvider outside an app shell", async () => {
  expect(
    await lintSingleRule("tooltip-provider-owner", source, {
      sourcePath: "source.tsx",
    }),
  ).toEqual([1]);
});

test.each([
  "apps/web/src/app-providers.tsx",
  "apps/desktop/src/mainview/main.tsx",
  "packages/mcp-apps/src/case-law-results/app.tsx",
  "packages/mcp-apps/src/decision-reader/app.tsx",
])("allows the app shell owner %s", async (sourcePath) => {
  expect(
    await lintSingleRule("tooltip-provider-owner", source, {
      cwd: "scratch",
      sourcePath,
    }),
  ).toEqual([]);
});

test("keeps similarly named modules restricted", async () => {
  expect(
    await lintSingleRule("tooltip-provider-owner", source, {
      cwd: "scratch",
      sourcePath: "apps/web/src/components/app-providers.tsx",
    }),
  ).toEqual([1]);
});

test("allows other tooltip exports", async () => {
  expect(
    await lintSingleRule(
      "tooltip-provider-owner",
      'import { Tooltip, TooltipTrigger } from "@stll/ui/tooltip";\nexport const Tip = () => <Tooltip><TooltipTrigger /></Tooltip>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
