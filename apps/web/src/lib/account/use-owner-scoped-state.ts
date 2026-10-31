import { useSyncExternalStore } from "react";

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
  const state = createOwnerScopedState({ read, write, getDefaultValue });
  const { owner, value } = useSyncExternalStore(
    state.subscribe,
    state.getSnapshot,
    state.getServerSnapshot,
  );
  const setValue = (next: T) => state.updateValue(owner, () => next);
  const updateValue = (update: (previous: T) => T) =>
    state.updateValue(owner, update);
  const refresh = () => state.refresh(owner);
  return { owner, value, setValue, updateValue, refresh };
};
