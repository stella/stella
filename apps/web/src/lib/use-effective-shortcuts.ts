import type { Hotkey } from "@tanstack/react-hotkeys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result, TaggedError } from "better-result";

import { authClient } from "@/lib/auth";
import { sessionOptions } from "@/lib/auth-queries";
import { toAuthClientError } from "@/lib/errors/auth";
import { SHORTCUT_GROUPS } from "@/lib/hotkeys";
import type { ShortcutGroup, ShortcutId } from "@/lib/hotkeys";
import {
  applyOverridesToGroups,
  parseUserShortcuts,
  resetShortcutOverride,
  serializeUserShortcuts,
  validateRebind,
} from "@/lib/shortcut-overrides";
import type { RebindError, ShortcutOverrides } from "@/lib/shortcut-overrides";

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
  const { data: raw } = useQuery({
    ...sessionOptions,
    enabled: false,
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

const DEFAULT_HOTKEY_BY_ID = new Map<ShortcutId, Hotkey>(
  SHORTCUT_GROUPS.flatMap((group) =>
    group.shortcuts.flatMap((shortcut) =>
      shortcut.binding.type === "hotkey"
        ? [[shortcut.id, shortcut.binding.hotkey]]
        : [],
    ),
  ),
);

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
  const fallback = DEFAULT_HOTKEY_BY_ID.get(id);
  if (!fallback) {
    // Ids reach this hook only from hotkey call sites; a missing default means
    // the registry and call site disagree — a programmer error, not runtime.
    panic(`No default hotkey for shortcut "${id}"`);
  }
  return fallback;
};

export class ShortcutPersistError extends TaggedError("ShortcutPersistError")<{
  message: string;
  cause: unknown;
}> {}

export type ShortcutRebinding = {
  readonly overrides: ShortcutOverrides;
  readonly groups: ShortcutGroup[];
  readonly rebind: (
    id: ShortcutId,
    hotkey: Hotkey,
  ) => Promise<RebindError | null>;
  readonly reset: (id: ShortcutId) => Promise<void>;
};

/**
 * Rebind and reset shortcuts, persisted per-user through
 * `authClient.updateUser` and optimistically reflected in the session cache so
 * every surface updates immediately. `rebind` returns a typed
 * {@link RebindError} on rejection (collision / not rebindable) without
 * persisting; persistence failures throw {@link ShortcutPersistError}.
 */
export const useShortcutRebinding = (): ShortcutRebinding => {
  const queryClient = useQueryClient();
  const overrides = useShortcutOverrides();
  const groups = applyOverridesToGroups(SHORTCUT_GROUPS, overrides);

  const persist = async (next: ShortcutOverrides): Promise<void> => {
    const serialized = serializeUserShortcuts(next);
    queryClient.setQueryData(sessionOptions.queryKey, (previous) =>
      previous
        ? { ...previous, user: { ...previous.user, userShortcuts: serialized } }
        : previous,
    );
    const result = await authClient.updateUser({ userShortcuts: serialized });
    if (result.error) {
      // Optimistic write diverged from the server; re-sync from source.
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
      throw new ShortcutPersistError({
        message: "Failed to persist keyboard shortcuts",
        cause: toAuthClientError(result.error),
      });
    }
  };

  const rebind = async (
    id: ShortcutId,
    hotkey: Hotkey,
  ): Promise<RebindError | null> => {
    const validated = validateRebind({ id, hotkey, groups, overrides });
    if (Result.isError(validated)) {
      return validated.error;
    }
    await persist(validated.value);
    return null;
  };

  const reset = async (id: ShortcutId): Promise<void> => {
    await persist(resetShortcutOverride(overrides, id));
  };

  return { overrides, groups, rebind, reset };
};
