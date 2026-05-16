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
