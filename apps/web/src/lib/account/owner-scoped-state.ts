import {
  isCurrentStorageOwner,
  onStorageOwnerChange,
  storageOwner,
} from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";

export type OwnerScopedStateOptions<T> = {
  read: (owner: StorageOwner) => T;
  write?: ((value: T, owner: StorageOwner) => void) | undefined;
};

/** A stable subscription boundary that restores state on each owner transition. */
export const createOwnerScopedState = <T>({
  read,
  write,
}: OwnerScopedStateOptions<T>) => {
  let snapshot: { owner: StorageOwner; value: T } | undefined;
  const listeners = new Set<() => void>();
  const getSnapshot = () => {
    const owner = storageOwner();
    if (snapshot?.owner !== owner) {
      snapshot = { owner, value: read(owner) };
    }
    return snapshot;
  };
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    getSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      const unsubscribeOwner = onStorageOwnerChange(() => {
        getSnapshot();
        listener();
      });
      return () => {
        listeners.delete(listener);
        unsubscribeOwner();
      };
    },
    updateValue: (owner: StorageOwner, update: (value: T) => T) => {
      if (!isCurrentStorageOwner(owner)) {
        return;
      }
      const value = update(getSnapshot().value);
      write?.(value, owner);
      snapshot = { owner, value };
      notify();
    },
    refresh: (owner: StorageOwner) => {
      if (!isCurrentStorageOwner(owner)) {
        return;
      }
      snapshot = { owner, value: read(owner) };
      notify();
    },
  };
};
