import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { requireBrowserStorage } from "@/lib/account/browser-storage";
import type { StorageArea } from "@/lib/account/storage-families";
import { readStoredJson, serializeStoredJson } from "@/lib/stored-json";

type PersistedStateScope = {
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
};

type PersistedStateKey<TScope extends object> =
  string | ((scope: TScope) => string);

type PersistedStateEntry<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends object,
> = {
  key: PersistedStateKey<TScope>;
  area: StorageArea;
  version: number;
  schema: TSchema;
  maxBytes: number;
  defaultValue: () => v.InferOutput<TSchema>;
  /** Every entry decides whether a stored value belongs to the reading scope. */
  scopeCheck: (
    value: v.InferOutput<TSchema>,
    scope: TScope,
  ) => ScopeDecision<v.InferOutput<TSchema>>;
  restoredUi: boolean;
  /** Released pre-envelope formats are validated and rewritten on their first read. */
  legacy?: {
    encoding: "json" | "text";
    schema: v.BaseSchema<unknown, v.InferOutput<TSchema>, v.BaseIssue<unknown>>;
  };
};

/**
 * Whether a stored value is kept for the reading scope. A separate `keep` flag
 * (not a null sentinel) because null is a valid value of nullable entries.
 */
export type ScopeDecision<T> = { keep: true; value: T } | { keep: false };

/** For entries whose key already pins the scope, or that have none. */
export const keepInAnyScope = <T>(value: T): ScopeDecision<T> => ({
  keep: true,
  value,
});

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
  TScope extends object = PersistedStateScope,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
) => entry;

export const getPersistedStateKey = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends object,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
): string => (typeof entry.key === "string" ? entry.key : entry.key(scope));

const removeStored = (area: StorageArea, key: string) =>
  requireBrowserStorage(area).andThen((storage) =>
    Result.try(() => storage.removeItem(key)),
  );

/** Best-effort cleanup after a read already fell back to the default. */
const removeInvalid = (area: StorageArea, key: string): void => {
  removeStored(area, key).unwrapOr(undefined);
};

export const isRestoredStateSafeMode = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  return Result.try(
    () => new URLSearchParams(window.location.search).get("safe") === "1",
  ).unwrapOr(false);
};

class PersistedStateWriteError extends TaggedError("PersistedStateWriteError")<{
  message: string;
  area: StorageArea;
  cause: unknown;
}> {}

export const writePersistedState = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends object,
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
  const key = getPersistedStateKey(entry, scope);
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

export const readPersistedState = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends object,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
): v.InferOutput<TSchema> => {
  const fallback = entry.defaultValue();
  if (entry.restoredUi && isRestoredStateSafeMode()) {
    return fallback;
  }
  const key = getPersistedStateKey(entry, scope);
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
  if (parsed === null && entry.legacy !== undefined) {
    const input =
      entry.legacy.encoding === "json"
        ? Result.try((): unknown => JSON.parse(raw))
        : Result.ok(raw);
    if (Result.isOk(input)) {
      const migrated = v.safeParse(entry.legacy.schema, input.value);
      if (migrated.success) {
        const decision = entry.scopeCheck(migrated.output, scope);
        if (!decision.keep) {
          removeInvalid(entry.area, key);
          return fallback;
        }
        writePersistedState(entry, scope, decision.value).unwrapOr(undefined);
        return decision.value;
      }
    }
  }
  if (parsed === null || parsed.version !== entry.version) {
    removeInvalid(entry.area, key);
    return fallback;
  }
  const decision = entry.scopeCheck(parsed.value, scope);
  if (!decision.keep) {
    removeInvalid(entry.area, key);
    return fallback;
  }
  return decision.value;
};

export const removePersistedState = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  TScope extends object,
>(
  entry: PersistedStateEntry<TSchema, TScope>,
  scope: TScope,
): ReturnType<typeof removeStored> =>
  removeStored(entry.area, getPersistedStateKey(entry, scope));
