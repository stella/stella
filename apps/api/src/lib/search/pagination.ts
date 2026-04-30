import { encodeCursor } from "@/api/lib/search/cursor";

export const GLOBAL_SEARCH_MAX_OFFSET = 1000;

export const resolveGlobalSearchNextCursor = ({
  limit,
  offset,
  totalCount,
}: {
  limit: number;
  offset: number;
  totalCount: number;
}): string | null => {
  const nextOffset = offset + limit;
  return totalCount > nextOffset && nextOffset < GLOBAL_SEARCH_MAX_OFFSET
    ? encodeCursor(nextOffset, "global")
    : null;
};
