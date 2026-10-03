import { useCallback, useSyncExternalStore } from "react";

import type { Hotkey } from "@tanstack/react-hotkeys";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { rootKeys, sessionOptions } from "@/lib/auth-query-options";
import { SHORTCUT_GROUPS } from "@/lib/hotkeys";
import type { ShortcutGroup, ShortcutId } from "@/lib/hotkeys";
import {
  applyOverridesToGroups,
  parseUserShortcuts,
} from "@/lib/shortcut-overrides";
import type { ShortcutOverrides } from "@/lib/shortcut-overrides";

const SESSION_QUERY_HASH = hashKey(rootKeys.session);

/**
 * The user's shortcut rebindings, read off the shared `["session"]` query that
 * every protected route already loads. A cache subscription never replaces the
 * session's fetch function or initiates a request (including on public pages), while
 * still re-rendering when the cache changes (an optimistic rebind, or the route
 * loader populating it). Returns an empty map when the user has never rebound
 * anything.
 */
export const useShortcutOverrides = (): ShortcutOverrides => {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === SESSION_QUERY_HASH) {
          onChange();
        }
      }),
    [queryClient],
  );
  const getSnapshot = useCallback(
    () =>
      queryClient.getQueryData(sessionOptions.queryKey)?.user.userShortcuts ??
      null,
    [queryClient],
  );
  const raw = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
