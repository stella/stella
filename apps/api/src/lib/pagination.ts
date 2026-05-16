export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  limit: number;
};

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
