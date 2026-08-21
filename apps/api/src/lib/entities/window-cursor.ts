import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const ENTITIES_WINDOW_CURSOR_VERSION = 2;

// Entity windows carry at most LIMITS.viewSortsCount projected field sort
// values: buildSortKeys emits one key per requested sort, plus a fixed set of
// built-in keys (three search-rank numbers and the entity id) whose values are
// short. JSON can expand one control character to six ASCII bytes; the 1024
// tail covers the version wrapper and those built-in keys before base64url
// encoding.
export const ENTITY_SORTABLE_FIELD_VALUE_MAX_LENGTH = 1000;
const ENTITIES_WINDOW_CURSOR_JSON_MAX_BYTES =
  LIMITS.viewSortsCount * ENTITY_SORTABLE_FIELD_VALUE_MAX_LENGTH * 6 + 1024;
export const ENTITIES_WINDOW_CURSOR_MAX_LENGTH =
  Math.ceil(ENTITIES_WINDOW_CURSOR_JSON_MAX_BYTES / 3) * 4;

export type EntitiesWindowCursorValue = string | number | null;
export type EntitiesWindowCursorValues = readonly EntitiesWindowCursorValue[];

const invalidCursor = () =>
  new HandlerError({ status: 400, message: "Invalid cursor" });

const isCursorValue = (value: unknown): value is EntitiesWindowCursorValue =>
  value === null || typeof value === "string" || typeof value === "number";

export const encodeEntitiesWindowCursor = (
  values: EntitiesWindowCursorValues,
): string =>
  Buffer.from(
    JSON.stringify({
      v: ENTITIES_WINDOW_CURSOR_VERSION,
      values,
    }),
  ).toString("base64url");

export const decodeEntitiesWindowCursor = (
  cursor: string | undefined,
): Result<EntitiesWindowCursorValues | null, HandlerError> => {
  if (cursor === undefined) {
    return Result.ok(null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    return Result.err(invalidCursor());
  }

  if (typeof parsed !== "object" || parsed === null) {
    return Result.err(invalidCursor());
  }

  if (!("v" in parsed) || parsed.v !== ENTITIES_WINDOW_CURSOR_VERSION) {
    return Result.err(invalidCursor());
  }

  if (!("values" in parsed) || !Array.isArray(parsed.values)) {
    return Result.err(invalidCursor());
  }

  if (!parsed.values.every(isCursorValue)) {
    return Result.err(invalidCursor());
  }

  return Result.ok(parsed.values);
};
