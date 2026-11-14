import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { GLOBAL_SEARCH_RESULT_LIMIT } from "@stll/api-contract/search";
import { compareCodeUnit } from "@stll/collation";

import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

export type GlobalSearchCursor = {
  tier: SearchRankingTier;
  score: number;
  id: string;
  seen: number;
};

const SEARCH_RANKING_TIERS = [0, 1, 2, 3, 4] as const;
export type SearchRankingTier = (typeof SEARCH_RANKING_TIERS)[number];

const parseSearchRankingTier = (value: string): SearchRankingTier | null => {
  switch (value) {
    case "0":
      return 0;
    case "1":
      return 1;
    case "2":
      return 2;
    case "3":
      return 3;
    case "4":
      return 4;
    default:
      return null;
  }
};

/**
 * A release that still served offset-paging replicas issued every keyset
 * payload behind an offset cursor and this separator. No replica reads the
 * offset any more, so the payload is issued alone; the prefixed form is still
 * read, because a page issued before the change can be continued after it.
 *
 * REMOVAL CONDITION: delete the prefixed read once every serving replica
 * issues the payload alone and the searches paged before that have ended.
 */
const PREFIXED_CURSOR_SEPARATOR = "==";

export const GLOBAL_SEARCH_HIT_ID_PREFIXES = [
  "entity:",
  "matter:",
  "contact:",
  "case-law:",
  "chat:",
] as const;

export type ParsedGlobalSearchCursor =
  | { type: "initial" }
  | { type: "keyset"; cursor: GlobalSearchCursor }
  | { type: "invalid" };

type ScoredSearchHit<T extends { id: string }> = {
  hit: T;
  tier: SearchRankingTier;
  score: number;
};

export const compareScoredSearchHits = <T extends { id: string }>(
  a: ScoredSearchHit<T>,
  b: ScoredSearchHit<T>,
): number =>
  b.tier - a.tier || b.score - a.score || compareCodeUnit(b.hit.id, a.hit.id);

export const isAfterGlobalSearchCursor = (
  hit: { id: string; tier: SearchRankingTier; score: number },
  cursor: GlobalSearchCursor,
): boolean =>
  hit.tier < cursor.tier ||
  (hit.tier === cursor.tier &&
    (hit.score < cursor.score ||
      (hit.score === cursor.score && compareCodeUnit(hit.id, cursor.id) < 0)));

const decodeGlobalSearchKeysetPayload = (
  cursor: string,
): GlobalSearchCursor | null => {
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    return null;
  }

  const separatorIndex = decoded.id.indexOf(":");
  const seen = parseIntegerToken(decoded.id.slice(0, separatorIndex), {
    sign: "unsigned",
  }).unwrapOr(null);
  const tierSeparatorIndex = decoded.id.indexOf(":", separatorIndex + 1);
  const tier = parseSearchRankingTier(
    decoded.id.slice(separatorIndex + 1, tierSeparatorIndex),
  );
  const id = decoded.id.slice(tierSeparatorIndex + 1);
  if (
    separatorIndex === -1 ||
    tierSeparatorIndex === -1 ||
    tier === null ||
    seen === null ||
    seen <= 0 ||
    seen >= GLOBAL_SEARCH_RESULT_LIMIT ||
    !GLOBAL_SEARCH_HIT_ID_PREFIXES.some(
      (prefix) => id.startsWith(prefix) && id.length > prefix.length,
    )
  ) {
    return null;
  }

  return { tier, score: decoded.score, id, seen };
};

export const parseGlobalSearchCursor = (
  cursor: string | undefined,
): ParsedGlobalSearchCursor => {
  if (cursor === undefined) {
    return { type: "initial" };
  }

  // Base64 padding ends a payload with the separator's own characters, so
  // only a separator with a payload after it marks a prefix. The prefix
  // restated the payload's `seen` and is not read.
  const separatorIndex = cursor.indexOf(PREFIXED_CURSOR_SEPARATOR);
  const payloadStart = separatorIndex + PREFIXED_CURSOR_SEPARATOR.length;
  const keysetCursor = decodeGlobalSearchKeysetPayload(
    separatorIndex !== -1 && payloadStart < cursor.length
      ? cursor.slice(payloadStart)
      : cursor,
  );
  return keysetCursor === null
    ? { type: "invalid" }
    : { type: "keyset", cursor: keysetCursor };
};

export const decodeGlobalSearchCursor = (
  cursor: string | undefined,
): GlobalSearchCursor | null => {
  const parsed = parseGlobalSearchCursor(cursor);
  return parsed.type === "keyset" ? parsed.cursor : null;
};

export const encodeGlobalSearchCursor = ({
  tier,
  score,
  id,
  seen,
}: GlobalSearchCursor): string => encodeCursor(score, `${seen}:${tier}:${id}`);

export const globalSearchCursorSql = ({
  cursor,
  score,
  tier,
  id,
}: {
  cursor: GlobalSearchCursor | null;
  score: SQL;
  tier: SQL;
  id: SQL;
}): SQL => {
  if (cursor === null) {
    return sql``;
  }

  return sql`
    AND (
      ${tier} < ${cursor.tier}
      OR (
        ${tier} = ${cursor.tier}
        AND (
          ${score} < ${cursor.score}
          OR (
            ${score} = ${cursor.score}
            AND (${id}) COLLATE "C" < ${cursor.id}::text COLLATE "C"
          )
        )
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
          tier: last.tier,
          id: last.hit.id,
          seen: nextSeen,
        })
      : null;

  return {
    items: page.map(({ hit }) => hit),
    nextCursor,
  };
};
