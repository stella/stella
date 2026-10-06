import {
  isCurrentStorageOwner,
  onStorageOwnerChange,
  storageOwner,
} from "@/lib/account/user-scoped-storage";
import type { StorageOwner } from "@/lib/account/user-scoped-storage";

const SERVER_OWNER = { kind: "visitor" } as const;
export const serverStorageOwner = () => SERVER_OWNER;

export type OwnerScopedStateOptions<T> = {
  getDefaultValue: () => T;
  read: (owner: StorageOwner) => T;
  write?: ((value: T, owner: StorageOwner) => void) | undefined;
};

/** A stable subscription boundary that restores state on each owner transition. */
export const createOwnerScopedState = <T>({
  read,
  write,
  getDefaultValue,
}: OwnerScopedStateOptions<T>) => {
  const serverSnapshot = {
    owner: serverStorageOwner(),
    value: getDefaultValue(),
  };
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
    getServerSnapshot: () => serverSnapshot,
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
