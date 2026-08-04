import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { SHORTCUT_GROUPS } from "@/lib/hotkeys";
import {
  applyOverridesToGroups,
  isRebindableShortcut,
  parseUserShortcuts,
  resetShortcutOverride,
  serializeUserShortcuts,
  validateRebind,
} from "@/lib/shortcut-overrides";
import type { ShortcutOverrides } from "@/lib/shortcut-overrides";

const bindingFor = (
  groups: readonly (typeof SHORTCUT_GROUPS)[number][],
  id: string,
) =>
  groups
    .flatMap((group) => group.shortcuts)
    .find((shortcut) => shortcut.id === id)?.binding;

describe("parseUserShortcuts", () => {
  test("keeps valid rebindable overrides and drops the rest", () => {
    const raw = JSON.stringify({
      search: "Mod+P",
      showShortcuts: "Mod+H", // not rebindable (char default)
      unknownId: "Mod+Z", // not a ShortcutId
      toggleChat: 42, // non-string
      toggleSidebar: "Mod", // no non-modifier key
    });
    const overrides = parseUserShortcuts(raw);
    expect(overrides.search).toEqual({ type: "hotkey", hotkey: "Mod+P" });
    expect(overrides.showShortcuts).toBeUndefined();
    expect(overrides.toggleChat).toBeUndefined();
    expect(overrides.toggleSidebar).toBeUndefined();
  });

  test("empty / malformed input yields no overrides", () => {
    expect(parseUserShortcuts(null)).toEqual({});
    expect(parseUserShortcuts(undefined)).toEqual({});
    expect(parseUserShortcuts("")).toEqual({});
    expect(parseUserShortcuts("not json")).toEqual({});
    expect(parseUserShortcuts("[]")).toEqual({});
  });

  test("round-trips through serialize", () => {
    const overrides: ShortcutOverrides = {
      search: { type: "hotkey", hotkey: "Mod+P" },
      newChat: { type: "hotkey", hotkey: "Mod+Shift+K" },
    };
    expect(parseUserShortcuts(serializeUserShortcuts(overrides))).toEqual(
      overrides,
    );
  });
});

describe("applyOverridesToGroups", () => {
  test("replaces only the overridden binding", () => {
    const groups = applyOverridesToGroups(SHORTCUT_GROUPS, {
      search: { type: "hotkey", hotkey: "Mod+P" },
    });
    expect(bindingFor(groups, "search")).toEqual({
      type: "hotkey",
      hotkey: "Mod+P",
    });
    // Untouched entries keep their defaults.
    expect(bindingFor(groups, "toggleSidebar")).toEqual({
      type: "hotkey",
      hotkey: "Mod+B",
    });
  });
});

describe("isRebindableShortcut", () => {
  test("hotkey defaults are rebindable, char defaults are not", () => {
    expect(isRebindableShortcut("search")).toBe(true);
    expect(isRebindableShortcut("showShortcuts")).toBe(false);
  });
});

describe("validateRebind", () => {
  test("accepts a free chord and returns the next override map", () => {
    const result = validateRebind({
      id: "search",
      hotkey: "Mod+P",
      groups: SHORTCUT_GROUPS,
      overrides: {},
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.search).toEqual({ type: "hotkey", hotkey: "Mod+P" });
    }
  });

  test("rejects a rebind that collides within a shared context", () => {
    // `search` and `toggleSidebar` are both global; rebinding search onto
    // toggleSidebar's default (Mod+B) collides in every context.
    const result = validateRebind({
      id: "search",
      hotkey: "Mod+B",
      groups: SHORTCUT_GROUPS,
      overrides: {},
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.type).toBe("collision");
      if (result.error.type === "collision") {
        expect(result.error.conflictLabelKey).toBe("navigation.toggleSidebar");
      }
    }
  });

  test("rejects a non-rebindable id", () => {
    const result = validateRebind({
      id: "showShortcuts",
      hotkey: "Mod+P",
      groups: SHORTCUT_GROUPS,
      overrides: {},
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.type).toBe("notRebindable");
    }
  });

  test("rejects a modifier-only chord", () => {
    const result = validateRebind({
      id: "search",
      hotkey: "Mod",
      groups: SHORTCUT_GROUPS,
      overrides: {},
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.type).toBe("invalidBinding");
    }
  });

  test("a rebind that only collides in a different context is allowed", () => {
    // `newChat` is workspace-only; binding it to `acceptSuggestion`'s default
    // (Alt+Enter, pdf-only) shares no context, so it must be accepted.
    const result = validateRebind({
      id: "newChat",
      hotkey: "Alt+Enter",
      groups: SHORTCUT_GROUPS,
      overrides: {},
    });
    expect(Result.isOk(result)).toBe(true);
  });
});

describe("resetShortcutOverride", () => {
  test("removes the override for an id", () => {
    const overrides: ShortcutOverrides = {
      search: { type: "hotkey", hotkey: "Mod+P" },
      newChat: { type: "hotkey", hotkey: "Mod+Shift+K" },
    };
    expect(resetShortcutOverride(overrides, "search")).toEqual({
      newChat: { type: "hotkey", hotkey: "Mod+Shift+K" },
    });
  });
});
