import { useSyncExternalStore } from "react";

import type * as v from "valibot";

import {
  persistedStorageAdapter,
  type PersistedStateDefinition,
  type PersistedStorageAdapter,
} from "@/hooks/persisted-storage-adapter";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

/**
 * The tab's storage after hydration. The server and hydration pass both see
 * null, so public pages never render browser state into their server markup.
 */
export const useSessionStorage = <
  TSchema extends v.BaseSchema<unknown, string | null, v.BaseIssue<unknown>>,
  TScope extends {
    organizationId?: string | undefined;
    workspaceId?: string | undefined;
  },
>(
  entry: PersistedStateDefinition<TSchema, TScope>,
  scope: TScope,
): PersistedStorageAdapter | null =>
  useSyncExternalStore(
    noopSubscribe,
    () => persistedStorageAdapter(entry, scope),
    () => null,
  );
