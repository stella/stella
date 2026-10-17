import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
import type { StorageArea } from "@/lib/account/storage-families";
import { readStoredJson, serializeStoredJson } from "@/lib/stored-json";

type PersistedStateScope = {
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
};

type PersistedStateKey<TScope extends PersistedStateScope> =
  | string
  | ((scope: TScope) => string);

type PersistedStateEntry<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends PersistedStateScope,
> = {
  key: PersistedStateKey<TScope>;
  area: StorageArea;
  version: number;
  schema: TSchema;
  maxBytes: number;
  defaultValue: () => v.InferOutput<TSchema>;
  scopeCheck?:
    | ((
        value: v.InferOutput<TSchema>,
        scope: TScope,
      ) => v.InferOutput<TSchema> | null)
    | undefined;
  restoredUi: boolean;
};

type PersistedEnvelope<T> = { version: number; value: T };

const envelopeSchema = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  schema: TSchema,
) =>
  v.object({
    version: v.number(),
    value: schema,
  });

export const definePersistedState = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends PersistedStateScope = PersistedStateScope,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
) => entry;

const entryKey = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends PersistedStateScope,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
): string => (typeof entry.key === "string" ? entry.key : entry.key(scope));

const removeInvalid = (area: StorageArea, key: string) =>
  requireBrowserStorage(area).andThen((storage) =>
    Result.try(() => storage.removeItem(key)),
  );

export const isRestoredStateSafeMode = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  return Result.try(
    () => new URLSearchParams(window.location.search).get("safe") === "1",
  ).unwrapOr(false);
};

export const readPersistedState = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends PersistedStateScope,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
): v.InferOutput<TSchema> => {
  const fallback = entry.defaultValue();
  if (entry.restoredUi && isRestoredStateSafeMode()) {
    return fallback;
  }
  const key = entryKey(entry, scope);
  const rawResult = requireBrowserStorage(entry.area).andThen((storage) =>
    Result.try(() => storage.getItem(key)),
  );
  if (Result.isError(rawResult) || rawResult.value === null) {
    return fallback;
  }
  const raw = rawResult.value;
  if (new TextEncoder().encode(raw).byteLength > entry.maxBytes) {
    removeInvalid(entry.area, key);
    return fallback;
  }
  const parsed = readStoredJson(raw, envelopeSchema(entry.schema));
  if (parsed === null || parsed.version !== entry.version) {
    removeInvalid(entry.area, key);
    return fallback;
  }
  const scoped = entry.scopeCheck?.(parsed.value, scope) ?? parsed.value;
  if (scoped === null) {
    removeInvalid(entry.area, key);
    return fallback;
  }
  return scoped;
};

class PersistedStateWriteError extends TaggedError("PersistedStateWriteError")<{
  message: string;
  area: StorageArea;
  cause: unknown;
}> {}

export const writePersistedState = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends PersistedStateScope,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
  value: v.InferOutput<TSchema>,
) => {
  const serialized = serializeStoredJson({
    version: entry.version,
    value,
  } satisfies PersistedEnvelope<v.InferOutput<TSchema>>);
  if (new TextEncoder().encode(serialized).byteLength > entry.maxBytes) {
    return Result.err(
      new PersistedStateWriteError({
        message: "Persisted state exceeds its size limit",
        area: entry.area,
        cause: null,
      }),
    );
  }
  const key = entryKey(entry, scope);
  const storageResult = requireBrowserStorage(entry.area);
  if (Result.isError(storageResult)) {
    return Result.err(
      new PersistedStateWriteError({
        message: "Browser storage is unavailable",
        area: entry.area,
        cause: storageResult.error,
      }),
    );
  }
  return Result.try({
    try: () => storageResult.value.setItem(key, serialized),
    catch: (cause) =>
      new PersistedStateWriteError({
        message: "Persisted state could not be written",
        area: entry.area,
        cause,
      }),
  });
};

export const removePersistedState = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends PersistedStateScope,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
) => removeInvalid(entry.area, entryKey(entry, scope));
