import type * as v from "valibot";
import type { PersistStorage, StorageValue } from "zustand/middleware";

import { areUserStorageWritesSuspended } from "@/lib/account/user-scoped-storage";
import {
  readPersistedState,
  removePersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";
import type { PersistedStateEntry } from "@/lib/persisted-state/registry";

/** Binds Zustand's persistence protocol to one registry-owned entry. */
export const registryZustandStorage = <
  T,
  TSchema extends v.BaseSchema<
    unknown,
    StorageValue<T> | null,
    v.BaseIssue<unknown>
  >,
  TScope extends object,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
  ownerScoped = false,
): PersistStorage<T> => ({
  getItem: () => readPersistedState(entry, scope),
  setItem: (_name, value) =>
    ownerScoped && areUserStorageWritesSuspended()
      ? undefined
      : writePersistedState(entry, scope, value),
  removeItem: () =>
    ownerScoped && areUserStorageWritesSuspended()
      ? undefined
      : removePersistedState(entry, scope),
});
