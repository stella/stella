import { useSyncExternalStore } from "react";

import type * as v from "valibot";

import {
  persistedStorageAdapter,
  type PersistedStateDefinition,
  type PersistedStorageAdapter,
} from "@/hooks/persisted-storage-adapter";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

/**
 * The browser's storage after hydration, or null where there is none: the
 * server, the hydration pass, and a profile that blocks it outright.
 *
 * The sibling of `useSessionStorage`, and the way a public SSR module reaches
 * persisted state at all: those modules may not name a browser global
 * themselves, so the storage is handed to them instead, and a module that
 * takes it as an argument is also one a test can drive with a fake.
 */
export const useLocalStorage = <
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
