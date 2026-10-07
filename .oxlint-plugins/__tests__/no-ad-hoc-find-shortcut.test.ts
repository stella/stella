import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects registry rebinding and manual recognition of the find press", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-find-shortcut",
      [
        'useEffectiveHotkey("find");',
        "const chord = HOTKEYS.FIND;",
        'const direct = event.key === "f";',
        'const folded = event.key.toLowerCase() !== "f";',
        'const reversed = "F" == event.key;',
        'const upper = event.key.toUpperCase() != "F";',
      ].join("\n"),
      { sourcePath: "apps/web/src/components/viewer.ts" },
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("allows surface registration and unrelated shortcuts", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-find-shortcut",
      [
        "useFindSurface({ onFind: openFind });",
        'useEffectiveHotkey("search");',
        "const chord = HOTKEYS.SEARCH;",
        'const closes = event.key === "Escape";',
      ].join("\n"),
      { sourcePath: "apps/web/src/components/viewer.ts" },
    ),
  ).toEqual([]);
});

test("allows the single find dispatcher to recognize its shortcut", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-find-shortcut",
      [
        'useEffectiveHotkey("find");',
        "const chord = HOTKEYS.FIND;",
        'const direct = event.key === "f";',
        'const folded = event.key.toLowerCase() !== "f";',
        'const reversed = "F" == event.key;',
        'const upper = event.key.toUpperCase() != "F";',
      ].join("\n"),
      { sourcePath: "apps/web/src/lib/find-owner.ts" },
    ),
  ).toEqual([]);
});

test("allows shortcut registry definitions", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-find-shortcut",
      [
        'useEffectiveHotkey("find");',
        "const chord = HOTKEYS.FIND;",
        'const direct = event.key === "f";',
        'const folded = event.key.toLowerCase() !== "f";',
        'const reversed = "F" == event.key;',
        'const upper = event.key.toUpperCase() != "F";',
      ].join("\n"),
      { sourcePath: "apps/web/src/lib/hotkeys.ts" },
    ),
  ).toEqual([]);
});

test("keeps the dispatcher basename restricted outside its owner directory", async () => {
  expect(
    await lintSingleRule(
      "no-ad-hoc-find-shortcut",
      [
        'useEffectiveHotkey("find");',
        "const chord = HOTKEYS.FIND;",
        'const direct = event.key === "f";',
        'const folded = event.key.toLowerCase() !== "f";',
        'const reversed = "F" == event.key;',
        'const upper = event.key.toUpperCase() != "F";',
      ].join("\n"),
      { sourcePath: "apps/web/src/components/find-owner.ts" },
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});
