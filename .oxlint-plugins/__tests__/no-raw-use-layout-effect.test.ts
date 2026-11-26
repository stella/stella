import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "no-raw-use-layout-effect";

test("reports each layout and insertion effect where it is imported", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { useLayoutEffect as layout, useState } from "react";\nimport { useInsertionEffect } from "react";\nlayout(() => {});\nuseInsertionEffect(() => {});\nuseState(0);',
    ),
  ).toEqual([1, 2]);
});

test("reports the hook chosen as a value, not only a call by name", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { useEffect, useLayoutEffect } from "react";\nconst useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;\nuseIsoLayoutEffect(() => {});',
    ),
  ).toEqual([1]);
});

test("reports namespace members and dynamically loaded hooks", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import * as React from "react";\nReact["useLayoutEffect"](() => {});\nconst { useInsertionEffect: loaded } = await import("react");\nloaded(() => {});',
    ),
  ).toEqual([2, 3]);
});

test("allows the sanctioned wrappers and unrelated local functions", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { useLayoutSyncEffect, useMountLayoutEffect } from "@stll/ui/effects";\nuseLayoutSyncEffect(() => {}, []);\nuseMountLayoutEffect(() => {});\nconst useLayoutEffect = (effect: () => void) => effect();\nuseLayoutEffect(() => {});',
    ),
  ).toEqual([]);
});

test.each([
  "packages/ui/src/effects/effects.ts",
  "packages/ui/src/effects/dom.ts",
])(
  "allows the effect owner %s to import React's layout effects",
  async (sourcePath) => {
    expect(
      await lintSingleRule(
        RULE,
        'import { useLayoutEffect } from "react";\nuseLayoutEffect(() => {});',
        { cwd: "scratch", sourcePath },
      ),
    ).toEqual([]);
  },
);

test("keeps copies of the owners restricted", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { useLayoutEffect } from "react";\nuseLayoutEffect(() => {});',
      { cwd: "scratch", sourcePath: "apps/web/src/other/effects.ts" },
    ),
  ).toEqual([1]);
});
