import type { HotkeyChord } from "@tanstack/react-hotkeys";
import { useQueryClient } from "@tanstack/react-query";
import { Result, TaggedError } from "better-result";

import { updateUserResource } from "@/lib/account/update-user";
import { sessionOptions } from "@/lib/auth-queries";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { SHORTCUT_GROUPS } from "@/lib/hotkeys";
import type { ShortcutGroup, ShortcutId } from "@/lib/hotkeys";
import {
  applyOverridesToGroups,
  resetShortcutOverride,
  serializeUserShortcuts,
  validateRebind,
} from "@/lib/shortcut-overrides";
import type { RebindError, ShortcutOverrides } from "@/lib/shortcut-overrides";
import { useShortcutOverrides } from "@/lib/use-effective-shortcuts";

class ShortcutPersistError extends TaggedError("ShortcutPersistError")<{
  message: string;
  cause: unknown;
}> {}

export type ShortcutRebinding = {
  readonly overrides: ShortcutOverrides;
  readonly groups: ShortcutGroup[];
  readonly rebind: (
    id: ShortcutId,
    hotkey: HotkeyChord,
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
  const user = useMaybeAuthenticatedUser();
  const overrides = useShortcutOverrides();
  const groups = applyOverridesToGroups(SHORTCUT_GROUPS, overrides);

  const persist = async (next: ShortcutOverrides): Promise<void> => {
    const serialized = serializeUserShortcuts(next);
    queryClient.setQueryData(sessionOptions.queryKey, (previous) =>
      previous
        ? { ...previous, user: { ...previous.user, userShortcuts: serialized } }
        : previous,
    );
    const result = await updateUserResource({
      queryClient,
      input: { userShortcuts: serialized },
      owner:
        user === null
          ? null
          : { userId: user.id, organizationId: user.activeOrganizationId },
    });
    if (Result.isError(result)) {
      // Optimistic write diverged from the server; re-sync from source.
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
      throw new ShortcutPersistError({
        message: "Failed to persist keyboard shortcuts",
        cause: result.error,
      });
    }
  };

  const rebind = async (
    id: ShortcutId,
    hotkey: HotkeyChord,
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
