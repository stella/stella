import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects ambient platform detection and display formatting imports", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-hotkey-format",
      'import { detectPlatform, formatForDisplay as display } from "@tanstack/hotkeys";',
    ),
  ).toEqual([1, 1]);
});

test("rejects namespace access to ambient hotkey APIs", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-hotkey-format",
      'import * as hotkeys from "@tanstack/react-hotkeys";',
    ),
  ).toEqual([1]);
});

test("accepts hydration-safe platform formatting", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-hotkey-format",
      'import { formatHotkeyForPlatform } from "@/lib/hotkeys";\nimport { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";',
    ),
  ).toEqual([]);
});

test("accepts hotkey registration without ambient formatting", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-hotkey-format",
      'import { useHotkey } from "@tanstack/react-hotkeys";',
    ),
  ).toEqual([]);
});

test("accepts the platform owner importing ambient APIs", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-hotkey-format",
      'import { detectPlatform } from "@tanstack/hotkeys";',
      { sourcePath: "apps/web/src/lib/hotkeys.ts" },
    ),
  ).toEqual([]);
});

test("accepts the hydration boundary importing ambient APIs", async () => {
  expect(
    await lintSingleRule(
      "no-ambient-hotkey-format",
      'import { detectPlatform } from "@tanstack/hotkeys";',
      {
        sourcePath: "apps/web/src/hooks/use-hydration-safe-hotkey-platform.ts",
      },
    ),
  ).toEqual([]);
});

test.each(["hotkeys.ts", "use-hydration-safe-hotkey-platform.ts"])(
  "keeps a same-basename %s copy restricted",
  async (name) => {
    expect(
      await lintSingleRule(
        "no-ambient-hotkey-format",
        'import { detectPlatform } from "@tanstack/hotkeys";',
        { sourcePath: `apps/web/src/components/${name}` },
      ),
    ).toEqual([1]);
  },
);
