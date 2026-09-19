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

/**
 * The characters every cursor encoder on this surface emits: the base64 and
 * base64url alphabets, plus padding. Both appear because the codecs differ
 * (`encodePaginationCursor` writes base64url, `lib/search/cursor.ts` writes
 * base64), and a reader admitting only one would call the other's output made
 * up.
 */
const CURSOR_ALPHABET = /^[A-Za-z0-9+/_=-]+$/u;

/** First printable code point: below it is C0, which no encoder emits because
 * JSON escapes those and an id has none. C1 is not tested, because a tenant
 * name carrying one still encodes into a cursor this API issued. */
const FIRST_PRINTABLE_CODE_POINT = 0x20;

const hasControlCharacter = (text: string): boolean => {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint < FIRST_PRINTABLE_CODE_POINT) {
      return true;
    }
  }
  return false;
};

/**
 * Could any encoder on this surface have issued this string?
 *
 * A client that must fill every declared property invents a cursor for its
 * first call: a space, a dot, `start`, `null`. None is a page boundary, so a
 * reader that hands them to a decoder answers `Invalid cursor` to a caller
 * that has no cursor to fix, and the caller invents another one. Asking
 * whether the string is even in the issued class separates that from a real
 * boundary that arrives damaged, which must still fail.
 *
 * The test is the one property every encoder here shares: base64 of readable
 * text. Deliberately no length rule; `WzIwXQ` (`[20]`) is a whole cursor, and
 * `encodeGlobalSearchCursor` concatenates two base64 payloads around `==`, so
 * no single length class covers the surface. What that costs is that a decimal
 * offset cursor (`10`) falls outside the class: such a surface passes its own
 * predicate rather than being read by this one.
 */
export const isIssuablePaginationCursor = (value: string): boolean => {
  if (!CURSOR_ALPHABET.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) {
    return false;
  }
  const text = bytes.toString("utf-8");
  // `toString` substitutes U+FFFD for a malformed sequence, so the round trip
  // is what distinguishes real text from bytes that merely rendered.
  return Buffer.from(text, "utf-8").equals(bytes) && !hasControlCharacter(text);
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
