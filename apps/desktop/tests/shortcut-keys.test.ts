import { describe, expect, test } from "bun:test";

import en from "../src/i18n/langs/en.json";
import {
  formatShortcut,
  heldModifiers,
  isClipboardShortcutSnapshot,
  isShortcutCheck,
  keyLabel,
  modifierOfKey,
  RESERVED_ACTIONS,
  sameShortcut,
  SHORTCUT_MODIFIERS,
  shortcutKeycaps,
} from "../src/shared/shortcut-keys";
import type { ShortcutKeys } from "../src/shared/shortcut-keys";
import { readNativeSource, rustEnumVariants } from "./rust-enum";

const NATIVE_SHORTCUT = readNativeSource("clipboard_shortcut.rs");

const DEFAULT_KEYS = {
  code: "KeyV",
  modifiers: ["shift", "super"],
} satisfies ShortcutKeys;

describe("shortcut labels", () => {
  test("follow each platform's modifier order and separator", () => {
    expect(
      formatShortcut({
        keys: DEFAULT_KEYS,
        layout: null,
        locale: "en",
        platform: "mac",
      }),
    ).toBe("⇧⌘V");
    expect(
      formatShortcut({
        keys: { code: "KeyV", modifiers: ["shift", "control"] },
        layout: null,
        locale: "en",
        platform: "windows",
      }),
    ).toBe("Ctrl+Shift+V");
  });

  test("use the key names printed on local keyboards outside macOS", () => {
    const keys = { code: "KeyV", modifiers: ["shift", "control"] } as const;
    expect(
      formatShortcut({
        keys: { ...keys, modifiers: [...keys.modifiers] },
        layout: null,
        locale: "de",
        platform: "windows",
      }),
    ).toBe("Strg+Umschalt+V");
    expect(
      formatShortcut({
        keys: { ...keys, modifiers: [...keys.modifiers] },
        layout: null,
        locale: "de-AT",
        platform: "mac",
      }),
    ).toBe("⌃⇧V");
  });

  test("name a letter by what the current layout types on that key", () => {
    const dvorak = {
      get: (code: string) => (code === "KeyV" ? "k" : undefined),
    };
    expect(keyLabel("KeyV", dvorak)).toBe("K");
    expect(keyLabel("KeyV", null)).toBe("V");
    expect(keyLabel("Digit7", null)).toBe("7");
    expect(keyLabel("Space", dvorak)).toBe("Space");
  });

  test("give every keycap in a row a distinct id", () => {
    for (const modifiers of [
      [],
      ["control"],
      [...SHORTCUT_MODIFIERS],
    ] as const) {
      const caps = shortcutKeycaps({
        keys: { code: "KeyK", modifiers: [...modifiers] },
        layout: null,
        locale: "en",
        platform: "windows",
      });
      expect(new Set(caps.map((cap) => cap.id)).size).toBe(caps.length);
    }
  });
});

describe("shortcut keys from events", () => {
  test("map every modifier key name and nothing else", () => {
    expect(modifierOfKey("Meta")).toBe("super");
    expect(modifierOfKey("AltGraph")).toBe("alt");
    expect(modifierOfKey("v")).toBeNull();
    expect(modifierOfKey("toString")).toBeNull();
  });

  test("read held modifiers from the event flags", () => {
    expect(
      heldModifiers({
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      }),
    ).toEqual(["control", "shift"]);
  });

  test("compare shortcuts regardless of modifier order", () => {
    expect(
      sameShortcut(DEFAULT_KEYS, {
        code: "KeyV",
        modifiers: ["super", "shift"],
      }),
    ).toBe(true);
    expect(
      sameShortcut(DEFAULT_KEYS, { code: "KeyV", modifiers: ["super"] }),
    ).toBe(false);
  });
});

describe("native shortcut contract", () => {
  test("reserved actions match the native enum and each has a name", () => {
    expect(rustEnumVariants(NATIVE_SHORTCUT, "ReservedAction")).toEqual([
      ...RESERVED_ACTIONS,
    ]);
    expect(Object.keys(en.shortcut.action)).toEqual([...RESERVED_ACTIONS]);
  });

  test("modifier names match the native enum", () => {
    expect(rustEnumVariants(NATIVE_SHORTCUT, "ShortcutModifier")).toEqual([
      ...SHORTCUT_MODIFIERS,
    ]);
  });

  test("registration states match the native enum", () => {
    expect(
      rustEnumVariants(
        readNativeSource("clipboard_shortcut.rs"),
        "ShortcutRegistration",
      ),
    ).toEqual(["active", "paused", "unavailable", "managed"]);
  });

  test("the guards accept the native shapes and reject drifted ones", () => {
    const snapshot = {
      defaultKeys: DEFAULT_KEYS,
      keys: DEFAULT_KEYS,
      registration: "active",
    };
    expect(isClipboardShortcutSnapshot(snapshot)).toBe(true);
    for (const registration of ["paused", "unavailable", "managed"]) {
      expect(isClipboardShortcutSnapshot({ ...snapshot, registration })).toBe(
        true,
      );
    }
    expect(
      isClipboardShortcutSnapshot({ ...snapshot, registration: "registered" }),
    ).toBe(false);
    expect(
      isShortcutCheck({
        rejection: { action: "selectAll", reason: "systemReserved" },
        status: "rejected",
      }),
    ).toBe(true);
    expect(
      isShortcutCheck({
        rejection: { action: "launchRocket", reason: "systemReserved" },
        status: "rejected",
      }),
    ).toBe(false);
  });
});
