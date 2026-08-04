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
 * Stable identity for every registry entry. Closed union so the echo matcher
 * and the per-user override map can reference entries type-safely: adding an
 * entry to {@link SHORTCUT_GROUPS} without listing its id here fails typecheck,
 * and an override or echo can only ever name a real shortcut.
 */
export type ShortcutId =
  | "search"
  | "toggleSidebar"
  | "toggleChat"
  | "newMatter"
  | "newChat"
  | "selectAll"
  | "acceptSuggestion"
  | "rejectSuggestion"
  | "previousSuggestion"
  | "nextSuggestion"
  | "showShortcuts";

/**
 * How a shortcut is bound. `hotkey` maps to a @tanstack `Hotkey` (bound with
 * `useHotkey`, displayed with `formatForDisplay`); `char` is a bare produced
 * character (layout-correct, matched via `KeyboardEvent.key`).
 */
export type ShortcutBinding =
  | { readonly type: "hotkey"; readonly hotkey: Hotkey }
  | { readonly type: "char"; readonly char: string };

export type ShortcutDescriptor = {
  readonly id: ShortcutId;
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
        id: "search",
        binding: { type: "hotkey", hotkey: HOTKEYS.SEARCH },
        labelKey: "navigation.search",
        contexts: ["global"],
      },
      {
        id: "toggleSidebar",
        binding: { type: "hotkey", hotkey: HOTKEYS.TOGGLE_SIDEBAR },
        labelKey: "navigation.toggleSidebar",
        contexts: ["global"],
      },
      {
        id: "toggleChat",
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
        id: "newMatter",
        binding: { type: "hotkey", hotkey: HOTKEYS.NEW_MATTER },
        labelKey: "common.newMatter",
        contexts: ["global", "workspace"],
      },
      {
        id: "newChat",
        binding: { type: "hotkey", hotkey: HOTKEYS.NEW_CHAT },
        labelKey: "chat.newChat",
        contexts: ["workspace"],
      },
      {
        id: "selectAll",
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
        id: "acceptSuggestion",
        binding: { type: "hotkey", hotkey: HOTKEYS.ACCEPT_SUGGESTION },
        labelKey: "common.accept",
        contexts: ["pdf"],
      },
      {
        id: "rejectSuggestion",
        binding: { type: "hotkey", hotkey: HOTKEYS.REJECT_SUGGESTION },
        labelKey: "docxReview.reject",
        contexts: ["pdf"],
      },
      {
        id: "previousSuggestion",
        binding: { type: "hotkey", hotkey: HOTKEYS.PREVIOUS_SUGGESTION },
        labelKey: "common.previous",
        contexts: ["pdf"],
      },
      {
        id: "nextSuggestion",
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
        id: "showShortcuts",
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

export type OverlayHint = {
  readonly hotkey: Hotkey;
  readonly labelKey: TranslationKey;
  readonly contexts: readonly ShortcutContext[];
};

export type OverlayHintGroup = {
  readonly categoryKey: TranslationKey;
  readonly hints: readonly OverlayHint[];
};

/**
 * Project a shortcut registry into hold-Mod overlay content. The overlay is
 * reachable only by holding Mod, so it lists exactly the Mod-chord shortcuts;
 * every other binding (bare chars, Alt chords) is cheatsheet-only.
 *
 * Kept a pure function of its argument (not hardcoded to {@link SHORTCUT_GROUPS})
 * so the overlay can pass the per-user *effective* registry and rebindings take
 * effect there too.
 */
export const deriveOverlayHintGroups = (
  groups: readonly ShortcutGroup[],
): OverlayHintGroup[] =>
  groups
    .map((group) => ({
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
    }))
    .filter((group) => group.hints.length > 0);

/**
 * Hold-Mod overlay content for the default registry. The overlay renders the
 * effective (per-user) projection at runtime; this default backs the
 * single-source-of-truth tests.
 */
export const OVERLAY_HINT_GROUPS = deriveOverlayHintGroups(SHORTCUT_GROUPS);

/**
 * Whether a keyboard event originates from a text-entry control. Global
 * shortcut handlers (the `?` cheatsheet, the press-echo listener) share this
 * guard so they never fire while the user is typing.
 */
export const isEditableEventTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

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
