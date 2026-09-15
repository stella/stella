import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = {
  [key: string]: JsonValue;
};
export type JsonArray = JsonValue[];

export const toJsonValue = (value: unknown): JsonValue => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (isRecord(value)) {
    return toJsonObject(value);
  }

  return null;
};

export const toJsonObject = (value: Record<string, unknown>): JsonObject => {
  const out: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    out[key] = toJsonValue(nestedValue);
  }
  return out;
};

const MAX_NULL_FOLD_DEPTH = 64;

/**
 * Drop object properties whose value is `null` or `undefined`, recursively.
 *
 * The comparison form of the "a null optional means absence" rule that
 * `withNullOptionalsOmitted` (`@/api/mcp/input-normalization`) applies from the
 * schema. Without a schema it cannot tell a provider-synthesized null from a
 * deliberate one, so it folds both: use it to compare two spellings of the same
 * value, never to produce one that gets persisted or sent to a provider.
 *
 * Array elements keep their positions, so a null element stays null.
 *
 * The value may come from a client, so the walk is bounded: below
 * `MAX_NULL_FOLD_DEPTH` a subtree is returned as is. A genuine tool input never
 * nests that deep, and an unfolded subtree only ever makes the comparison
 * fail, so the bound cannot admit a value that would otherwise be rejected.
 */
export const withNullsOmitted = (value: unknown, depth = 0): unknown => {
  if (depth >= MAX_NULL_FOLD_DEPTH) {
    return value;
  }
  if (isUnknownArray(value)) {
    return value.map((entry) => withNullsOmitted(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return value;
  }
  const present: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) {
      continue;
    }
    present[key] = withNullsOmitted(entry, depth + 1);
  }
  return present;
};
