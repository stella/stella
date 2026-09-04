import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { compareCodepoint } from "@stll/collation";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

export type GlobalSearchCursor = {
  score: number;
  id: string;
  seen: number;
};

export const GLOBAL_SEARCH_RESULT_LIMIT = 1000;

const LEGACY_GLOBAL_SEARCH_CURSOR_ID = "global";
const DUAL_CURSOR_SEPARATOR = "==";

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
  | { type: "legacy"; offset: number }
  | { type: "invalid" };

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

const decodeGlobalSearchKeysetPayload = (
  cursor: string,
): GlobalSearchCursor | null => {
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    return null;
  }

  const separatorIndex = decoded.id.indexOf(":");
  const seen = Number(decoded.id.slice(0, separatorIndex));
  const id = decoded.id.slice(separatorIndex + 1);
  if (
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

const decodeLegacyGlobalSearchOffset = (cursor: string): number | null => {
  const decoded = decodeCursor(cursor);
  if (
    decoded?.id !== LEGACY_GLOBAL_SEARCH_CURSOR_ID ||
    !Number.isInteger(decoded.score) ||
    decoded.score < 0 ||
    decoded.score >= GLOBAL_SEARCH_RESULT_LIMIT
  ) {
    return null;
  }

  return decoded.score;
};

export const parseGlobalSearchCursor = (
  cursor: string | undefined,
): ParsedGlobalSearchCursor => {
  if (cursor === undefined) {
    return { type: "initial" };
  }

  const dualSeparatorIndex = cursor.indexOf(DUAL_CURSOR_SEPARATOR);
  if (
    dualSeparatorIndex !== -1 &&
    dualSeparatorIndex + DUAL_CURSOR_SEPARATOR.length < cursor.length
  ) {
    const legacyPayload = cursor.slice(0, dualSeparatorIndex);
    const keysetPayload = cursor.slice(
      dualSeparatorIndex + DUAL_CURSOR_SEPARATOR.length,
    );
    const offset = decodeLegacyGlobalSearchOffset(legacyPayload);
    const keysetCursor = decodeGlobalSearchKeysetPayload(keysetPayload);
    if (
      offset === null ||
      keysetCursor === null ||
      offset !== keysetCursor.seen
    ) {
      return { type: "invalid" };
    }
    return { type: "keyset", cursor: keysetCursor };
  }

  const keysetCursor = decodeGlobalSearchKeysetPayload(cursor);
  if (keysetCursor !== null) {
    return { type: "keyset", cursor: keysetCursor };
  }

  const offset = decodeLegacyGlobalSearchOffset(cursor);
  return offset === null ? { type: "invalid" } : { type: "legacy", offset };
};

export const decodeGlobalSearchCursor = (
  cursor: string | undefined,
): GlobalSearchCursor | null => {
  const parsed = parseGlobalSearchCursor(cursor);
  return parsed.type === "keyset" ? parsed.cursor : null;
};

export const encodeGlobalSearchCursor = ({
  score,
  id,
  seen,
}: GlobalSearchCursor): string => {
  // The prefix remains a valid offset cursor for replicas running the previous
  // release. New replicas use the suffix for keyset pagination, so requests can
  // move safely between old and new replicas during a rolling deployment.
  const encodedLegacyCursor = encodeCursor(
    seen,
    LEGACY_GLOBAL_SEARCH_CURSOR_ID,
  );
  const paddingIndex = encodedLegacyCursor.indexOf("=");
  const legacyPayload =
    paddingIndex === -1
      ? encodedLegacyCursor
      : encodedLegacyCursor.slice(0, paddingIndex);
  const keysetPayload = encodeCursor(score, `${seen}:${id}`);
  return `${legacyPayload}${DUAL_CURSOR_SEPARATOR}${keysetPayload}`;
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
