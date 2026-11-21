import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("reports each direct React effect call while leaving imports clean", async () => {
  expect(
    await lintSingleRule(
      "no-raw-use-effect",
      'import { useEffect as effect } from "react";\neffect(() => {});\neffect(() => {}, []);',
    ),
  ).toEqual([2, 3]);
});

test("reports namespace and dynamically loaded React effect calls", async () => {
  expect(
    await lintSingleRule(
      "no-raw-use-effect",
      'import * as React from "react";\nReact["useEffect"](() => {});\nconst { useEffect: loadedEffect } = await import("react");\nloadedEffect(() => {});',
    ),
  ).toEqual([2, 4]);
});

test("allows sanctioned wrappers and unrelated local effect functions", async () => {
  expect(
    await lintSingleRule(
      "no-raw-use-effect",
      'import { useMountEffect, useExternalSyncEffect } from "@/hooks/use-effect";\nuseMountEffect(() => {});\nuseExternalSyncEffect(() => {}, []);\nconst useEffect = (effect: () => void) => effect();\nuseEffect(() => {});',
    ),
  ).toEqual([]);
});

test("allows the effect wrapper owner to call React", async () => {
  expect(
    await lintSingleRule(
      "no-raw-use-effect",
      'import { useEffect } from "react";\nuseEffect(() => {});',
      { cwd: "scratch", sourcePath: "apps/web/src/hooks/use-effect.ts" },
    ),
  ).toEqual([]);
});

test("keeps copies of the effect owner restricted", async () => {
  expect(
    await lintSingleRule(
      "no-raw-use-effect",
      'import { useEffect } from "react";\nuseEffect(() => {});',
      { cwd: "scratch", sourcePath: "apps/web/src/hooks/use-effect.copy.ts" },
    ),
  ).toEqual([2]);
});

test("keeps the owner basename restricted in another directory", async () => {
  expect(
    await lintSingleRule(
      "no-raw-use-effect",
      'import { useEffect } from "react";\nuseEffect(() => {});',
      { cwd: "scratch", sourcePath: "apps/web/src/other/use-effect.ts" },
    ),
  ).toEqual([2]);
});
