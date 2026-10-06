import { useCallback, useMemo, useSyncExternalStore } from "react";

import { createOwnerScopedState } from "@/lib/account/owner-scoped-state";
import type { OwnerScopedStateOptions } from "@/lib/account/owner-scoped-state";
import {
  onStorageOwnerChange,
  storageOwner,
} from "@/lib/account/user-scoped-storage";

export const useStorageOwner = () =>
  useSyncExternalStore(onStorageOwnerChange, storageOwner, storageOwner);

export const useOwnerScopedState = <T>({
  read,
  write,
}: OwnerScopedStateOptions<T>) => {
  const state = useMemo(
    () => createOwnerScopedState({ read, write }),
    [read, write],
  );
  const { owner, value } = useSyncExternalStore(
    state.subscribe,
    state.getSnapshot,
    state.getSnapshot,
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
