import { describe, expect, test } from "bun:test";

import {
  formatShortcutBinding,
  OVERLAY_HINT_GROUPS,
  SHORTCUT_CONTEXTS,
  SHORTCUT_GROUPS,
} from "@/lib/hotkeys";
import {
  bindingKey,
  collectShortcutCandidates,
  findContextCollisions,
} from "@/lib/shortcut-overrides";

const allShortcuts = SHORTCUT_GROUPS.flatMap((group) =>
  group.shortcuts.map((shortcut) => ({
    categoryKey: group.categoryKey,
    ...shortcut,
  })),
);

const registryModHotkeys = SHORTCUT_GROUPS.flatMap((group) =>
  group.shortcuts.flatMap((shortcut) =>
    shortcut.binding.type === "hotkey" &&
    shortcut.binding.hotkey.startsWith("Mod")
      ? [shortcut.binding.hotkey]
      : [],
  ),
);

describe("shortcut registry is the single source of truth", () => {
  // Kills the drift bug class: the cheatsheet renders the full registry and the
  // hold-Mod overlay is derived from it, so a shortcut cannot exist in one
  // surface without the other.
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

  test("the hold-Mod overlay is exactly the Mod-chord projection of the registry", () => {
    const overlayHotkeys = OVERLAY_HINT_GROUPS.flatMap((group) =>
      group.hints.map((hint) => hint.hotkey),
    );
    expect(overlayHotkeys.toSorted()).toEqual(registryModHotkeys.toSorted());
  });

  test("non-Mod bindings (e.g. `?`) are cheatsheet-only, never in the overlay", () => {
    const overlayKeys = new Set(
      OVERLAY_HINT_GROUPS.flatMap((group) =>
        group.hints.map((hint) => `hotkey:${hint.hotkey}`),
      ),
    );
    const nonModShortcuts = allShortcuts.filter(
      (shortcut) =>
        !(
          shortcut.binding.type === "hotkey" &&
          shortcut.binding.hotkey.startsWith("Mod")
        ),
    );
    expect(nonModShortcuts.length).toBeGreaterThan(0);
    for (const shortcut of nonModShortcuts) {
      expect(overlayKeys.has(bindingKey(shortcut.binding))).toBe(false);
    }
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
