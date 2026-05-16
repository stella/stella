export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  limit: number;
};

type CursorPrimitive = string | number | boolean | null;

type CursorPageOptions<T> = {
  rows: readonly T[];
  limit: number;
  cursorForItem: (item: T) => string;
};

const dateOnlyCursorPartPattern = /^\d{4}-\d{2}-\d{2}$/u;
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

export const encodePaginationCursor = (
  parts: readonly CursorPrimitive[],
): string => Buffer.from(JSON.stringify(parts)).toString("base64url");

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
): value is string => {
  if (typeof value !== "string" || !dateOnlyCursorPartPattern.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

export const isUuidPaginationCursorPart = (value: unknown): value is string =>
  typeof value === "string" && uuidCursorPartPattern.test(value);

export const parseDateTimePaginationCursorPart = (
  value: unknown,
): Date | null => {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return null;
  }

  return parsed;
};
