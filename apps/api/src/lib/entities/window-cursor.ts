import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

const ENTITIES_WINDOW_CURSOR_VERSION = 2;

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
