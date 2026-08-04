import { describe, expect, test } from "bun:test";

import {
  formatShortcutBinding,
  OVERLAY_HINT_GROUPS,
  SHORTCUT_CONTEXTS,
  SHORTCUT_GROUPS,
} from "@/lib/hotkeys";
import type { ShortcutBinding } from "@/lib/hotkeys";

const allShortcuts = SHORTCUT_GROUPS.flatMap((group) =>
  group.shortcuts.map((shortcut) => ({
    categoryKey: group.categoryKey,
    ...shortcut,
  })),
);

/** Canonical identity for a binding, used to detect collisions. */
const bindingKey = (binding: ShortcutBinding): string =>
  binding.type === "hotkey" ? `hotkey:${binding.hotkey}` : `char:${binding.char}`;

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
  // Kills the collision bug class: the same key combo bound twice inside one
  // ShortcutContext (directly, or via a "global" shortcut active everywhere) is
  // a test failure.
  test.each([...SHORTCUT_CONTEXTS])("context %s has no duplicate combos", (context) => {
    const active = allShortcuts.filter((shortcut) =>
      shortcut.contexts.some((c) => c === context || c === "global"),
    );
    const combos = active.map((shortcut) => bindingKey(shortcut.binding));
    const duplicates = combos.filter(
      (combo, index) => combos.indexOf(combo) !== index,
    );
    expect(duplicates).toEqual([]);
  });
});
