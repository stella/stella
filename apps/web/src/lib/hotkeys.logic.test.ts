import { describe, expect, test } from "bun:test";

import {
  formatHotkeyForPlatform,
  formatShortcutBinding,
  HOTKEYS,
  resolveHydrationSafeHotkeyPlatform,
  SHORTCUT_CONTEXTS,
  SHORTCUT_GROUPS,
  SSR_HOTKEY_PLATFORM,
} from "@/lib/hotkeys";
import type { HotkeyPlatform } from "@/lib/hotkeys";
import {
  collectShortcutCandidates,
  findContextCollisions,
} from "@/lib/shortcut-overrides";

const HOTKEY_PLATFORM_BY_NAME = {
  mac: "mac",
  windows: "windows",
  linux: "linux",
} as const satisfies Record<HotkeyPlatform, HotkeyPlatform>;

const HOTKEY_PLATFORMS = Object.values(HOTKEY_PLATFORM_BY_NAME);

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
      for (const platform of HOTKEY_PLATFORMS) {
        expect(
          formatShortcutBinding(shortcut.binding, platform).length,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("every registry shortcut has a unique, stable id", () => {
    const ids = allShortcuts.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("SSR-visible shortcut labels", () => {
  test("stay identical for every registered shortcut and platform pair", () => {
    const hotkeys = Object.values(HOTKEYS);

    for (const hotkey of hotkeys) {
      for (const serverPlatform of HOTKEY_PLATFORMS) {
        expect(
          resolveHydrationSafeHotkeyPlatform({
            status: "pre-mount",
            detected: serverPlatform,
          }),
        ).toBe(SSR_HOTKEY_PLATFORM);
        const serverLabel = formatHotkeyForPlatform(
          hotkey,
          resolveHydrationSafeHotkeyPlatform({
            status: "pre-mount",
            detected: serverPlatform,
          }),
        );

        for (const clientPlatform of HOTKEY_PLATFORMS) {
          expect(
            resolveHydrationSafeHotkeyPlatform({
              status: "mounted",
              detected: clientPlatform,
            }),
          ).toBe(clientPlatform);
          const firstClientLabel = formatHotkeyForPlatform(
            hotkey,
            resolveHydrationSafeHotkeyPlatform({
              status: "pre-mount",
              detected: clientPlatform,
            }),
          );
          const mountedClientLabel = formatHotkeyForPlatform(
            hotkey,
            resolveHydrationSafeHotkeyPlatform({
              status: "mounted",
              detected: clientPlatform,
            }),
          );

          expect(firstClientLabel).toBe(serverLabel);
          expect(mountedClientLabel).toBe(
            formatHotkeyForPlatform(hotkey, clientPlatform),
          );
        }
      }
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
