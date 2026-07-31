import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { compareCodepoint } from "@/api/lib/collation";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

export type GlobalSearchCursor = {
  score: number;
  id: string;
  seen: number;
};

export const GLOBAL_SEARCH_RESULT_LIMIT = 1000;

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
  const separatorIndex = decoded?.id.indexOf(":") ?? -1;
  const seen = Number(decoded?.id.slice(0, separatorIndex));
  const id = decoded?.id.slice(separatorIndex + 1) ?? "";
  if (
    decoded === null ||
    separatorIndex === -1 ||
    !Number.isInteger(seen) ||
    seen <= 0 ||
    seen >= GLOBAL_SEARCH_RESULT_LIMIT ||
    !GLOBAL_SEARCH_HIT_ID_PREFIXES.some(
      (prefix) => id.startsWith(prefix) && id.length > prefix.length,
    )
  ) {
    return null;
  }

  return { score: decoded.score, id, seen };
};

export const encodeGlobalSearchCursor = ({
  score,
  id,
  seen,
}: GlobalSearchCursor): string => encodeCursor(score, `${seen}:${id}`);

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

type PaginateScoredSearchHitsOptions<T extends { id: string }> = {
  scoredHits: readonly ScoredSearchHit<T>[];
  limit: number;
  seen: number;
};

export const paginateScoredSearchHits = <T extends { id: string }>({
  scoredHits,
  limit,
  seen,
}: PaginateScoredSearchHitsOptions<T>): {
  items: T[];
  nextCursor: string | null;
} => {
  const pageLimit = Math.max(
    0,
    Math.min(limit, GLOBAL_SEARCH_RESULT_LIMIT - seen),
  );
  const page = scoredHits.slice(0, pageLimit);
  const last = page.at(-1);
  const nextSeen = seen + page.length;
  const nextCursor =
    scoredHits.length > pageLimit &&
    last !== undefined &&
    nextSeen < GLOBAL_SEARCH_RESULT_LIMIT
      ? encodeGlobalSearchCursor({
          score: last.score,
          id: last.hit.id,
          seen: nextSeen,
        })
      : null;

  return {
    items: page.map(({ hit }) => hit),
    nextCursor,
  };
};
