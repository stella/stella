import { panic, Result } from "better-result";

import { parsePlainDate, Temporal } from "@stll/time";

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  limit: number;
};

type CursorPrimitive = string | number | boolean | null;

/**
 * One position inside an encoded cursor. A record part exists for a merged
 * cursor whose sub-positions are keyed rather than ordered (one per corpus
 * country, say): a positional array would make a key appearing or disappearing
 * a silent misalignment, while a keyed one just starts that source at its
 * first page.
 */
type CursorPart = CursorPrimitive | Readonly<Record<string, CursorPrimitive>>;

type CursorPageOptions<T> = {
  rows: readonly T[];
  limit: number;
  cursorForItem: (item: T) => string;
};

const uuidCursorPartPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export const createCursorPage = <T>({
  rows,
  limit,
  cursorForItem,
}: CursorPageOptions<T>): Page<T> => {
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);

  return {
    items,
    limit,
    nextCursor:
      rows.length > limit && lastItem !== undefined
        ? cursorForItem(lastItem)
        : null,
  };
};

/**
 * Walk cursor pages sequentially, retaining only the current page.
 * @yields The items in each fetched page.
 */
export async function* iterateCursorPages<T>(
  readPage: (cursor: string | null) => Promise<Page<T>>,
): AsyncGenerator<T[]> {
  let cursor: string | null = null;
  do {
    const page = await readPage(cursor);
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      panic("Cursor page did not advance");
    }
    yield page.items;
    cursor = page.nextCursor;
  } while (cursor !== null);
}

export const encodePaginationCursor = (parts: readonly CursorPart[]): string =>
  Buffer.from(JSON.stringify(parts)).toString("base64url");

export const decodePaginationCursor = (cursor: string): unknown[] | null => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    );

    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const isDateOnlyPaginationCursorPart = (
  value: unknown,
): value is string =>
  typeof value === "string" && parsePlainDate(value) !== null;

export const isUuidPaginationCursorPart = (value: unknown): value is string =>
  typeof value === "string" && uuidCursorPartPattern.test(value);

export const parseDateTimePaginationCursorPart = (
  value: unknown,
): Date | null => {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Result.try(() => Temporal.Instant.from(value)).unwrapOr(null);
  if (
    parsed === null ||
    parsed.toString({ fractionalSecondDigits: 3 }) !== value
  ) {
    return null;
  }
  return new Date(parsed.epochMilliseconds);
};
