import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { compareCodepoint } from "@/api/lib/collation";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

export type GlobalSearchCursor = {
  score: number;
  id: string;
};

const GLOBAL_SEARCH_HIT_ID_PREFIXES = [
  "entity:",
  "matter:",
  "contact:",
  "case-law:",
  "chat:",
] as const;

type ScoredSearchHit<T extends { id: string }> = {
  hit: T;
  score: number;
};

export const compareScoredSearchHits = <T extends { id: string }>(
  a: ScoredSearchHit<T>,
  b: ScoredSearchHit<T>,
): number => b.score - a.score || compareCodepoint(b.hit.id, a.hit.id);

export const isAfterGlobalSearchCursor = (
  hit: { id: string; score: number },
  cursor: GlobalSearchCursor,
): boolean =>
  hit.score < cursor.score ||
  (hit.score === cursor.score && compareCodepoint(hit.id, cursor.id) < 0);

export const decodeGlobalSearchCursor = (
  cursor: string | undefined,
): GlobalSearchCursor | null => {
  if (cursor === undefined) {
    return null;
  }

  const decoded = decodeCursor(cursor);
  if (
    decoded === null ||
    !GLOBAL_SEARCH_HIT_ID_PREFIXES.some(
      (prefix) =>
        decoded.id.startsWith(prefix) && decoded.id.length > prefix.length,
    )
  ) {
    return null;
  }

  return decoded;
};

export const globalSearchCursorSql = ({
  cursor,
  score,
  id,
}: {
  cursor: GlobalSearchCursor | null;
  score: SQL;
  id: SQL;
}): SQL => {
  if (cursor === null) {
    return sql``;
  }

  return sql`
    AND (
      ${score} < ${cursor.score}
      OR (
        ${score} = ${cursor.score}
        AND (${id}) COLLATE "C" < ${cursor.id}::text COLLATE "C"
      )
    )
  `;
};

export const paginateScoredSearchHits = <T extends { id: string }>(
  scoredHits: readonly ScoredSearchHit<T>[],
  limit: number,
): { items: T[]; nextCursor: string | null } => {
  const page = scoredHits.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    scoredHits.length > limit && last !== undefined
      ? encodeCursor(last.score, last.hit.id)
      : null;

  return {
    items: page.map(({ hit }) => hit),
    nextCursor,
  };
};
