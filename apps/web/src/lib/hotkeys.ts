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

export const NAV_KEY: IndividualKey =
  detectPlatform() === "mac" ? "Control" : "Alt";

export const SHORTCUT_CONTEXTS = ["global", "workspace", "pdf"] as const;

export type ShortcutContext = (typeof SHORTCUT_CONTEXTS)[number];

/**
 * How a shortcut is bound. `hotkey` maps to a @tanstack `Hotkey` (bound with
 * `useHotkey`, displayed with `formatForDisplay`); `char` is a bare produced
 * character (layout-correct, matched via `KeyboardEvent.key`).
 */
export type ShortcutBinding =
  | { readonly type: "hotkey"; readonly hotkey: Hotkey }
  | { readonly type: "char"; readonly char: string };

/**
 * The exact no-argument message keys used as shortcut and category labels.
 * Narrowing to this literal subset (rather than the full `TranslationKey`, which
 * includes keys that require ICU arguments) lets `t(key)` resolve to the
 * no-values overload, and keeps the registry's type-instantiation cost small.
 */
export type ShortcutCategoryKey = Extract<
  TranslationKey,
  | "navigation.shortcutCategories.navigation"
  | "navigation.shortcutCategories.review"
  | "navigation.shortcutCategories.help"
  | "common.actions"
>;

export type ShortcutLabelKey = Extract<
  TranslationKey,
  | "navigation.search"
  | "navigation.toggleSidebar"
  | "navigation.toggleChat"
  | "navigation.showShortcuts"
  | "common.newMatter"
  | "common.accept"
  | "common.previous"
  | "common.next"
  | "chat.newChat"
  | "folio.selectAll"
  | "docxReview.reject"
>;

type ShortcutDescriptorShape = {
  readonly id: string;
  readonly binding: ShortcutBinding;
  readonly labelKey: ShortcutLabelKey;
  readonly contexts: readonly ShortcutContext[];
};

type ShortcutGroupShape = {
  readonly categoryKey: ShortcutCategoryKey;
  readonly shortcuts: readonly ShortcutDescriptorShape[];
};

/**
 * Single source of truth for app-level keyboard shortcuts. The `?` cheatsheet
 * dialog (`KeyboardShortcutsDialog`), the press-echo HUD, and every real
 * `useHotkey` registration read their content from this registry (via the
 * per-user effective merge), so a shortcut cannot drift between what is shown
 * and what is bound. Adding a shortcut here is the only way to surface it;
 * there is no hand-maintained second list.
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
        contexts: ["global", "workspace"],
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
] as const satisfies readonly ShortcutGroupShape[];

/** Stable identity derived from the only shortcut registry. */
export type ShortcutId =
  (typeof SHORTCUT_GROUPS)[number]["shortcuts"][number]["id"];

export type ShortcutDescriptor = Omit<ShortcutDescriptorShape, "id"> & {
  readonly id: ShortcutId;
};

export type ShortcutGroup = {
  readonly categoryKey: ShortcutCategoryKey;
  readonly shortcuts: readonly ShortcutDescriptor[];
};

export type HotkeyPlatform = ReturnType<typeof detectPlatform>;

export const SSR_HOTKEY_PLATFORM: HotkeyPlatform = "linux";

export type HotkeyPlatformState =
  | { readonly status: "pre-mount"; readonly detected: HotkeyPlatform }
  | { readonly status: "mounted"; readonly detected: HotkeyPlatform };

/**
 * The server and first browser render always use one canonical platform.
 * Once mounted, labels can safely switch to the browser's detected platform.
 */
export const resolveHydrationSafeHotkeyPlatform = (
  state: HotkeyPlatformState,
): HotkeyPlatform =>
  state.status === "mounted" ? state.detected : SSR_HOTKEY_PLATFORM;

export const formatHotkeyForPlatform = (
  hotkey: Hotkey,
  platform: HotkeyPlatform,
): string => formatForDisplay(hotkey, { platform });

/**
 * Format a shortcut's full, platform-correct key combo for display. Callers
 * must pass the platform returned by useHydrationSafeHotkeyPlatform().
 */
export const formatShortcutBinding = (
  binding: ShortcutBinding,
  platform: HotkeyPlatform,
): string =>
  binding.type === "hotkey"
    ? formatHotkeyForPlatform(binding.hotkey, platform)
    : binding.char;

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
