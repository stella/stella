import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

const ENTITIES_WINDOW_CURSOR_VERSION = 1;

const invalidCursor = () =>
  new HandlerError({ status: 400, message: "Invalid cursor" });

export const encodeEntitiesWindowCursor = (offset: number): string =>
  Buffer.from(
    JSON.stringify({
      v: ENTITIES_WINDOW_CURSOR_VERSION,
      offset,
    }),
  ).toString("base64");

export const decodeEntitiesWindowCursor = (
  cursor: string | undefined,
): Result<number, HandlerError> => {
  if (cursor === undefined) {
    return Result.ok(0);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64").toString());
  } catch {
    return Result.err(invalidCursor());
  }

  if (typeof parsed !== "object" || parsed === null) {
    return Result.err(invalidCursor());
  }

  if (!("v" in parsed) || parsed.v !== ENTITIES_WINDOW_CURSOR_VERSION) {
    return Result.err(invalidCursor());
  }

  if (!("offset" in parsed)) {
    return Result.err(invalidCursor());
  }

  const { offset } = parsed;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    return Result.err(invalidCursor());
  }

  return Result.ok(offset);
};
