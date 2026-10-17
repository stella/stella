import type * as v from "valibot";

import type { StorageArea } from "@/lib/account/storage-families";
import {
  readPersistedState,
  removePersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

export type PersistedStateDefinition<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends {
    organizationId?: string | undefined;
    workspaceId?: string | undefined;
  },
> = {
  key: string | ((scope: TScope) => string);
  area: StorageArea;
  version: number;
  schema: TSchema;
  maxBytes: number;
  defaultValue: () => v.InferOutput<TSchema>;
  scopeCheck: (
    value: v.InferOutput<TSchema>,
    scope: TScope,
  ) => { keep: true; value: v.InferOutput<TSchema> } | { keep: false };
  restoredUi: boolean;
};

export type PersistedStorageAdapter = Storage;

const adapters = new WeakMap<object, Map<string, PersistedStorageAdapter>>();

export const persistedStorageAdapter = <
  TSchema extends v.BaseSchema<unknown, string | null, v.BaseIssue<unknown>>,
  TScope extends {
    organizationId?: string | undefined;
    workspaceId?: string | undefined;
  },
>(
  entry: PersistedStateDefinition<TSchema, TScope>,
  scope: TScope,
): PersistedStorageAdapter => {
  const scopeKey = JSON.stringify(scope);
  const entryAdapters =
    adapters.get(entry) ?? new Map<string, PersistedStorageAdapter>();
  const existing = entryAdapters.get(scopeKey);
  if (existing !== undefined) {
    return existing;
  }
  const adapter: PersistedStorageAdapter = {
    length: 1,
    clear: () => {
      removePersistedState(entry, scope);
    },
    getItem: () => readPersistedState(entry, scope),
    key: () => null,
    removeItem: () => {
      removePersistedState(entry, scope);
    },
    setItem: (_key, value) => {
      writePersistedState(entry, scope, value);
    },
  };
  entryAdapters.set(scopeKey, adapter);
  adapters.set(entry, entryAdapters);
  return adapter;
};
