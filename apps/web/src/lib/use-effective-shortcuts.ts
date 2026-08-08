import type { Hotkey } from "@tanstack/react-hotkeys";
import { skipToken, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import { SHORTCUT_GROUPS } from "@/lib/hotkeys";
import type { ShortcutGroup, ShortcutId } from "@/lib/hotkeys";
import {
  applyOverridesToGroups,
  parseUserShortcuts,
} from "@/lib/shortcut-overrides";
import type { ShortcutOverrides } from "@/lib/shortcut-overrides";

type ShortcutSessionData = {
  user: {
    userShortcuts?: string | null;
  };
};

// This mirrors the auth session cache key without importing its query module.
// Public SSR shells use the read-only shortcut hooks, so this module must not
// statically pull the authenticated query or browser auth client into SSR.
const SESSION_QUERY_KEY = ["session"] as const;

/**
 * The user's shortcut rebindings, read off the shared `["session"]` query that
 * every protected route already loads. `enabled: false` makes this a pure cache
 * read: it never initiates the session request itself (so it adds no route-load
 * request, and stays safe on public pages where no session is loaded), while
 * still re-rendering when the cache changes (an optimistic rebind, or the route
 * loader populating it). Returns an empty map when the user has never rebound
 * anything.
 */
export const useShortcutOverrides = (): ShortcutOverrides => {
  const { data: raw } = useQuery<
    ShortcutSessionData | null,
    Error,
    string | null
  >({
    queryKey: SESSION_QUERY_KEY,
    queryFn: skipToken,
    select: (data) => data?.user.userShortcuts ?? null,
  });
  return parseUserShortcuts(raw);
};

/**
 * The effective shortcut registry: defaults from {@link SHORTCUT_GROUPS} with
 * the user's overrides applied. Every shortcut surface reads from here so a
 * rebind changes the cheatsheet, the hold-Mod overlay, the press echo, and the
 * real `useHotkey` registrations together.
 */
export const useEffectiveShortcutGroups = (): ShortcutGroup[] => {
  const overrides = useShortcutOverrides();
  return applyOverridesToGroups(SHORTCUT_GROUPS, overrides);
};

/**
 * The registry's default chord for an id, or `undefined` when that shortcut's
 * default is a `char` binding. The registry is a small compiled-in constant, so
 * scanning it beats holding a module-level lookup table alive.
 */
const defaultHotkeyFor = (id: ShortcutId): Hotkey | undefined => {
  for (const group of SHORTCUT_GROUPS) {
    for (const shortcut of group.shortcuts) {
      if (shortcut.id === id && shortcut.binding.type === "hotkey") {
        return shortcut.binding.hotkey;
      }
    }
  }
  return undefined;
};

/**
 * The effective hotkey for a rebindable shortcut: the user's override if set,
 * else the default. Call sites pass the result to `useHotkey`, which
 * re-registers when the returned string changes, so a rebind rebinds the real
 * handler. Only ids with a hotkey default are passed here.
 */
export const useEffectiveHotkey = (id: ShortcutId): Hotkey => {
  const overrides = useShortcutOverrides();
  const override = overrides[id];
  if (override) {
    return override.hotkey;
  }
  const fallback = defaultHotkeyFor(id);
  if (!fallback) {
    // Ids reach this hook only from hotkey call sites; a missing default means
    // the registry and call site disagree — a programmer error, not runtime.
    panic(`No default hotkey for shortcut "${id}"`);
  }
  return fallback;
};
