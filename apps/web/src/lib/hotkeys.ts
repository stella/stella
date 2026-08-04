import { detectPlatform, formatForDisplay } from "@tanstack/react-hotkeys";
import type { IndividualKey, Hotkey } from "@tanstack/react-hotkeys";

import type { TranslationKey } from "@/i18n/types";

export const HOTKEYS = {
  TOGGLE_SIDEBAR: "Mod+B",
  SEARCH: "Mod+K",
  TOGGLE_CHAT: "Mod+J",
  NEW_CHAT: "Mod+Shift+J",
  NEW_MATTER: "Mod+Shift+E",
  SELECT_ALL: "Mod+A",
  ACCEPT_SUGGESTION: "Alt+Enter",
  REJECT_SUGGESTION: "Alt+Shift+Enter",
  NEXT_SUGGESTION: "Alt+ArrowDown",
  PREVIOUS_SUGGESTION: "Alt+ArrowUp",
} as const satisfies Record<string, Hotkey>;

/**
 * The cheatsheet dialog opens on `?`. `Shift+/` is intentionally NOT a
 * TanStack `Hotkey` (that type excludes `Shift+<punctuation>` because the
 * physical key that yields `?` is keyboard-layout dependent). We match the
 * produced character via `KeyboardEvent.key` instead, which is layout-correct.
 */
export const SHOW_SHORTCUTS_KEY = "?";

export const MOD_KEY: IndividualKey =
  detectPlatform() === "mac" ? "Meta" : "Control";

export const NAV_KEY: IndividualKey =
  detectPlatform() === "mac" ? "Control" : "Alt";

export type ShortcutContext = "global" | "workspace" | "pdf";

export const SHORTCUT_CONTEXTS: readonly ShortcutContext[] = [
  "global",
  "workspace",
  "pdf",
];

/**
 * How a shortcut is bound. `hotkey` maps to a @tanstack `Hotkey` (bound with
 * `useHotkey`, displayed with `formatForDisplay`); `char` is a bare produced
 * character (layout-correct, matched via `KeyboardEvent.key`).
 */
export type ShortcutBinding =
  | { readonly type: "hotkey"; readonly hotkey: Hotkey }
  | { readonly type: "char"; readonly char: string };

export type ShortcutDescriptor = {
  readonly binding: ShortcutBinding;
  readonly labelKey: TranslationKey;
  readonly contexts: readonly ShortcutContext[];
};

export type ShortcutGroup = {
  readonly categoryKey: TranslationKey;
  readonly shortcuts: readonly ShortcutDescriptor[];
};

/**
 * Single source of truth for app-level keyboard shortcuts. BOTH the
 * hold-Mod overlay (`ShortcutHintsOverlay`) and the `?` cheatsheet dialog
 * (`KeyboardShortcutsDialog`) derive their content from this registry, so a
 * shortcut cannot exist in one surface without the other. Adding a shortcut
 * here is the only way to surface it; there is no hand-maintained second list.
 */
export const SHORTCUT_GROUPS = [
  {
    categoryKey: "navigation.shortcutCategories.navigation",
    shortcuts: [
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.SEARCH },
        labelKey: "navigation.search",
        contexts: ["global"],
      },
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.TOGGLE_SIDEBAR },
        labelKey: "navigation.toggleSidebar",
        contexts: ["global"],
      },
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.TOGGLE_CHAT },
        labelKey: "navigation.toggleChat",
        contexts: ["global"],
      },
    ],
  },
  {
    categoryKey: "common.actions",
    shortcuts: [
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.NEW_MATTER },
        labelKey: "common.newMatter",
        contexts: ["global", "workspace"],
      },
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.NEW_CHAT },
        labelKey: "chat.newChat",
        contexts: ["workspace"],
      },
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.SELECT_ALL },
        labelKey: "folio.selectAll",
        contexts: ["workspace"],
      },
    ],
  },
  {
    categoryKey: "navigation.shortcutCategories.review",
    shortcuts: [
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.ACCEPT_SUGGESTION },
        labelKey: "common.accept",
        contexts: ["pdf"],
      },
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.REJECT_SUGGESTION },
        labelKey: "docxReview.reject",
        contexts: ["pdf"],
      },
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.PREVIOUS_SUGGESTION },
        labelKey: "common.previous",
        contexts: ["pdf"],
      },
      {
        binding: { type: "hotkey", hotkey: HOTKEYS.NEXT_SUGGESTION },
        labelKey: "common.next",
        contexts: ["pdf"],
      },
    ],
  },
  {
    categoryKey: "navigation.shortcutCategories.help",
    shortcuts: [
      {
        binding: { type: "char", char: SHOW_SHORTCUTS_KEY },
        labelKey: "navigation.showShortcuts",
        contexts: ["global"],
      },
    ],
  },
] as const satisfies readonly ShortcutGroup[];

/**
 * Format a shortcut's full, platform-correct key combo for display in the
 * cheatsheet (e.g. `⌘K` on macOS, `Ctrl+K` elsewhere). Unlike
 * `formatHintKey`, the Mod prefix is preserved.
 */
export const formatShortcutBinding = (binding: ShortcutBinding): string =>
  binding.type === "hotkey" ? formatForDisplay(binding.hotkey) : binding.char;

/**
 * Hold-Mod overlay content, derived from {@link SHORTCUT_GROUPS}. The overlay
 * is reachable only by holding Mod, so it lists exactly the Mod-chord
 * shortcuts; every other binding (bare chars, Alt chords) is cheatsheet-only.
 *
 * Types are derived from the value (not annotated) so the literal label/category
 * keys survive: annotating them as the broad `TranslationKey` union would force
 * `t()` onto its interpolation overload for keys that take no arguments.
 */
export const OVERLAY_HINT_GROUPS = SHORTCUT_GROUPS.map((group) => ({
  categoryKey: group.categoryKey,
  hints: group.shortcuts.flatMap((shortcut) =>
    shortcut.binding.type === "hotkey" &&
    shortcut.binding.hotkey.startsWith("Mod")
      ? [
          {
            hotkey: shortcut.binding.hotkey,
            labelKey: shortcut.labelKey,
            contexts: shortcut.contexts,
          },
        ]
      : [],
  ),
})).filter((group) => group.hints.length > 0);

export type OverlayHintGroup = (typeof OVERLAY_HINT_GROUPS)[number];
export type OverlayHint = OverlayHintGroup["hints"][number];

const CTRL_PREFIX_RE = /^Ctrl\+/u;

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
