import { useCallback, useSyncExternalStore } from "react";

import type * as v from "valibot";

import type { PersistedStateDefinition } from "@/hooks/persisted-storage-adapter";
import { readPersistedState } from "@/lib/persisted-state/registry";

const getServerSnapshot = () => false;

/** Reads a persisted flag without changing the client's hydration snapshot. */
export const useLocalStorageFlag = <
  TSchema extends v.BaseSchema<unknown, boolean, v.BaseIssue<unknown>>,
  TScope extends {
    organizationId?: string | undefined;
    workspaceId?: string | undefined;
  },
>(
  entry: PersistedStateDefinition<TSchema, TScope>,
  scope: TScope,
): boolean => {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener("storage", onStoreChange);
    return () => window.removeEventListener("storage", onStoreChange);
  }, []);
  const getSnapshot = useCallback(
    () => readPersistedState(entry, scope),
    [entry, scope],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
};
