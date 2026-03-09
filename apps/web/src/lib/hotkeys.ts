import {
  detectPlatform,
  formatForDisplay,
  type HeldKey,
  type Hotkey,
} from "@tanstack/react-hotkeys";

import type { TranslationKey } from "@/i18n/types";

export const HOTKEYS = {
  TOGGLE_SIDEBAR: "Mod+B",
  SEARCH: "Mod+K",
  TOGGLE_CHAT: "Mod+J",
  NEW_MATTER: "Mod+Shift+E",
  TOGGLE_TIME_TRACKING: "Mod+Shift+H",
  SELECT_ALL: "Mod+A",
} as const satisfies Record<string, Hotkey>;

export const MOD_KEY: HeldKey = detectPlatform() === "mac" ? "Meta" : "Control";

export const NAV_KEY: HeldKey = detectPlatform() === "mac" ? "Control" : "Alt";

export type ShortcutContext = "global" | "workspace" | "pdf";

export const SHORTCUT_HINT_GROUPS = [
  {
    categoryKey: "navigation.shortcutCategories.navigation",
    hints: [
      {
        hotkey: HOTKEYS.SEARCH,
        labelKey: "navigation.search",
        contexts: ["global"],
      },
      {
        hotkey: HOTKEYS.TOGGLE_SIDEBAR,
        labelKey: "navigation.toggleSidebar",
        contexts: ["global"],
      },
      {
        hotkey: HOTKEYS.TOGGLE_CHAT,
        labelKey: "navigation.toggleChat",
        contexts: ["global"],
      },
    ],
  },
  {
    categoryKey: "navigation.shortcutCategories.actions",
    hints: [
      {
        hotkey: HOTKEYS.NEW_MATTER,
        labelKey: "navigation.newMatter",
        contexts: ["global", "workspace"],
      },
      {
        hotkey: HOTKEYS.TOGGLE_TIME_TRACKING,
        labelKey: "navigation.timeTracking",
        contexts: ["global"],
      },
    ],
  },
] as const satisfies ReadonlyArray<{
  categoryKey: string;
  hints: ReadonlyArray<{
    hotkey: Hotkey;
    labelKey: TranslationKey;
    contexts: readonly ShortcutContext[];
  }>;
}>;

export type ShortcutHint =
  (typeof SHORTCUT_HINT_GROUPS)[number]["hints"][number];

export const SHORTCUT_HINTS: readonly ShortcutHint[] =
  SHORTCUT_HINT_GROUPS.flatMap((g): readonly ShortcutHint[] => g.hints);

const CTRL_PREFIX_RE = /^Ctrl\+/;

/**
 * Simulate a hotkey by dispatching synthetic keyboard events.
 * TanStack's KeyStateTracker listens on document for keydown/keyup,
 * so dispatching events triggers the registered handlers.
 */
export const triggerHotkey = (hotkey: Hotkey): void => {
  const parts = hotkey.split("+");
  const keys: { key: string; code: string }[] = [];

  for (const part of parts) {
    if (part === "Mod") {
      const isMac = detectPlatform() === "mac";
      keys.push({
        key: isMac ? "Meta" : "Control",
        code: isMac ? "MetaLeft" : "ControlLeft",
      });
    } else if (part === "Shift") {
      keys.push({ key: "Shift", code: "ShiftLeft" });
    } else if (part === "Alt") {
      keys.push({ key: "Alt", code: "AltLeft" });
    } else {
      keys.push({
        key: part.length === 1 ? part.toLowerCase() : part,
        code: part.length === 1 ? `Key${part.toUpperCase()}` : part,
      });
    }
  }

  const modifiers = {
    metaKey: keys.some((k) => k.key === "Meta"),
    ctrlKey: keys.some((k) => k.key === "Control"),
    shiftKey: keys.some((k) => k.key === "Shift"),
    altKey: keys.some((k) => k.key === "Alt"),
  };

  for (const k of keys) {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: k.key,
        code: k.code,
        bubbles: true,
        ...modifiers,
      }),
    );
  }

  // Skip Mod keyup: the user is still physically holding Mod
  // (they triggered the shortcut from the hold-to-reveal overlay).
  // Dispatching a synthetic Mod keyup confuses useKeyHold and
  // causes the overlay to reappear after 500ms.

  for (const k of keys.toReversed()) {
    if (["Meta", "Control"].includes(k.key)) {
      continue;
    }
    document.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: k.key,
        code: k.code,
        bubbles: true,
      }),
    );
  }
};

/**
 * Format a hotkey for the hold-to-reveal overlay by stripping
 * the Mod prefix. Since Mod is already held, we only show the
 * remaining key(s) the user needs to press.
 *
 * Mac:  "⌘K" -> "K",  "⇧⌘E" -> "⇧E"
 * Win:  "Ctrl+K" -> "K",  "Ctrl+Shift+E" -> "Shift+E"
 */
export const formatHintKey = (hotkey: Hotkey): string => {
  const display = formatForDisplay(hotkey);
  const platform = detectPlatform();
  if (platform === "mac") {
    return display.replace("\u2318", "");
  }
  return display.replace(CTRL_PREFIX_RE, "");
};
