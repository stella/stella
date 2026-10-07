import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects blocker imports including aliases", async () => {
  expect(
    await lintSingleRule(
      "no-direct-unsaved-work-guard",
      'import { useBlocker as block, Block } from "@tanstack/react-router";',
    ),
  ).toEqual([1, 1]);
});

test("rejects computed namespace blocker calls", async () => {
  expect(
    await lintSingleRule(
      "no-direct-unsaved-work-guard",
      'import * as Router from "@tanstack/react-router";\nRouter["useBlocker"]({ guard });',
    ),
  ).toEqual([2]);
});

test("rejects raw unload listeners with literal or template event names", async () => {
  expect(
    await lintSingleRule(
      "no-direct-unsaved-work-guard",
      'window.addEventListener("beforeunload", handler);\ntarget.addEventListener(`beforeunload`, handler);',
    ),
  ).toEqual([1, 2]);
});

test("accepts shared unsaved-work guards and unrelated events", async () => {
  expect(
    await lintSingleRule(
      "no-direct-unsaved-work-guard",
      'useUnsavedWork({ surface, guard, isDirty });\nwindow.addEventListener("pagehide", handler);\nimport { useRouter } from "@tanstack/react-router";',
    ),
  ).toEqual([]);
});

test("accepts the explicitly configured guard owner", async () => {
  expect(
    await lintSingleRule(
      "no-direct-unsaved-work-guard",
      'window.addEventListener("beforeunload", handler);',
      {
        sourcePath: "apps/web/src/hooks/use-unsaved-work.ts",
        ruleOptions: {
          allowedFiles: ["apps/web/src/hooks/use-unsaved-work.ts"],
        },
      },
    ),
  ).toEqual([]);
});

test("keeps a same-basename copy outside the guard owner confined", async () => {
  expect(
    await lintSingleRule(
      "no-direct-unsaved-work-guard",
      'window.addEventListener("beforeunload", handler);',
      {
        sourcePath: "apps/web/src/components/use-unsaved-work.ts",
        ruleOptions: {
          allowedFiles: ["apps/web/src/hooks/use-unsaved-work.ts"],
        },
      },
    ),
  ).toEqual([1]);
});
