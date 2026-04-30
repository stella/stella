import { encodeCursor } from "@/api/lib/search/cursor";

export const GLOBAL_SEARCH_MAX_OFFSET = 1000;

export const resolveGlobalSearchNextCursor = ({
  limit,
  offset,
  totalCount,
  hitsLength,
}: {
  limit: number;
  offset: number;
  /**
   * Real total when known (first page); pass `null` when count was
   * skipped (paginated request) so the decision falls back to hit count.
   */
  totalCount: number | null;
  hitsLength: number;
}): string | null => {
  const nextOffset = offset + limit;
  if (nextOffset >= GLOBAL_SEARCH_MAX_OFFSET) {
    return null;
  }
  // A short page means no more rows beyond this one.
  if (hitsLength < limit) {
    return null;
  }
  // When we know the total, refuse to advance past it.
  if (totalCount !== null && totalCount <= nextOffset) {
    return null;
  }
  return encodeCursor(nextOffset, "global");
};
