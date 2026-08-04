import { describe, expect, test } from "bun:test";

import {
  formatShortcutBinding,
  SHORTCUT_CONTEXTS,
  SHORTCUT_GROUPS,
} from "@/lib/hotkeys";
import {
  collectShortcutCandidates,
  findContextCollisions,
} from "@/lib/shortcut-overrides";

const allShortcuts = SHORTCUT_GROUPS.flatMap((group) =>
  group.shortcuts.map((shortcut) => ({
    categoryKey: group.categoryKey,
    ...shortcut,
  })),
);

describe("shortcut registry is the single source of truth", () => {
  // Kills the drift bug class: the cheatsheet renders the full registry, so a
  // shortcut cannot exist without a unique, labelled row.
  test("every registry shortcut renders in the cheatsheet with a unique row", () => {
    const rows = allShortcuts.map(
      (shortcut) => `${shortcut.categoryKey}::${shortcut.labelKey}`,
    );
    expect(new Set(rows).size).toBe(rows.length);

    for (const shortcut of allShortcuts) {
      expect(formatShortcutBinding(shortcut.binding).length).toBeGreaterThan(0);
    }
  });

  test("every registry shortcut has a unique, stable id", () => {
    const ids = allShortcuts.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("no colliding shortcuts within a context", () => {
  // Kills the collision bug class through the SAME shared checker the runtime
  // rebind save-guard uses: the default registry must be collision-free in
  // every context.
  test("the default registry has no in-context collisions", () => {
    const collisions = findContextCollisions(
      collectShortcutCandidates(SHORTCUT_GROUPS),
      SHORTCUT_CONTEXTS,
    );
    expect(collisions).toEqual([]);
  });
});
