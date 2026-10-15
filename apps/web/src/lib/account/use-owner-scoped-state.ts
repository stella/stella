import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  createOwnerScopedState,
  serverStorageOwner,
} from "@/lib/account/owner-scoped-state";
import type { OwnerScopedStateOptions } from "@/lib/account/owner-scoped-state";
import {
  onStorageOwnerChange,
  storageOwner,
} from "@/lib/account/user-scoped-storage";

export const useStorageOwner = () =>
  useSyncExternalStore(onStorageOwnerChange, storageOwner, serverStorageOwner);

export const useOwnerScopedState = <T>({
  read,
  write,
  getDefaultValue,
}: OwnerScopedStateOptions<T>) => {
  const state = useMemo(
    () => createOwnerScopedState({ read, write, getDefaultValue }),
    [read, write, getDefaultValue],
  );
  const { owner, value } = useSyncExternalStore(
    state.subscribe,
    state.getSnapshot,
    state.getServerSnapshot,
  );
  const setValue = useCallback(
    (next: T) => state.updateValue(owner, () => next),
    [owner, state],
  );
  const updateValue = useCallback(
    (update: (previous: T) => T) => state.updateValue(owner, update),
    [owner, state],
  );
  const refresh = useCallback(() => state.refresh(owner), [owner, state]);
  return { owner, value, setValue, updateValue, refresh };
};
