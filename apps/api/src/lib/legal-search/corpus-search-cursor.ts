/**
 * The wire format of a corpus-index search cursor: its one owner.
 *
 * A page boundary is only meaningful inside the ranking that produced it, and
 * three things decide that ranking. The scan window fixes which slice of the
 * engine's order was ranked, so a continuation has to resume in the same
 * window or rank a different slice against the page's boundary. Under
 * `QUERY_EXPANSION_MODE="on"` the engine query itself is a function of the
 * dictionary the serving replica had loaded, so two replicas mid-rebuild build
 * two different queries from one request. And the sort order decides what the
 * engine's order is at all: a boundary in a relevance ranking bounds nothing
 * in a date ranking. Any mismatch skips or repeats decisions behind an
 * ordinary-looking page.
 *
 * All three therefore travel in the cursor, which is the only thing that
 * survives between the two requests, and one codec owns them: a second module
 * encoding part of this string is a second answer to what a page boundary
 * means.
 *
 * Current form, inside the shared `(score, id)` framing:
 *
 *     base64("<score>:<windowStart>:<dictionary>:<sort>:<id>")
 *
 * `windowStart` is a decimal rank, `dictionary` is a payload's sha256 hex or
 * `none`, `sort` is one of `SEARCH_SORTS`, and `id` is one segment — the
 * corpus addresses documents by uuid, so the grammar is fixed-width in its
 * metadata and needs no escaping rule.
 *
 * REMOVAL CONDITION: delete `legacy` handling in `decodeCorpusSearchCursor`
 * in the release after the next one, once no replica issuing a shorter form
 * can still be serving.
 *
 * Three shorter forms were issued to clients before this one, and a rolling
 * deploy hands them back mid-pagination, so all are read rather than
 * rejected. Their identity is `none` and their order is `relevance` soundly,
 * not as a courtesy: no release issuing them could run the expanded query or
 * any order but relevance, so that is exactly what each page was built with.
 *
 *   - `<score>:<id>` predates windows, expansion and sorting, and window 0 is
 *     where a scan with no window began.
 *   - `<score>:<windowStart>:<id>` predates expansion and sorting, so its
 *     window is read as written.
 *   - `<score>:<windowStart>:<dictionary>:<id>` predates sorting only.
 *
 * One metadata segment therefore means a window rank and nothing else.
 */

import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";
import {
  type ExpansionDictionaryIdentity,
  NO_EXPANSION_DICTIONARY_IDENTITY,
  parseExpansionDictionaryIdentity,
  sameExpansionDictionary,
  serializeExpansionDictionaryIdentity,
} from "@/api/lib/legal-search/morphology/dictionary";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

/**
 * The scan's own boundary plus the dictionary that built the query it ranked
 * and the order it ranked in. Derived from `SearchCursor` rather than
 * restated, so a field the scan starts carrying cannot go missing from the
 * format that has to survive the request.
 */
export type CorpusSearchCursor = SearchCursor & {
  dictionary: ExpansionDictionaryIdentity;
};

/**
 * A window rank on the wire: decimal digits, bounded so the parse is total.
 * Ten digits is far above any rank a scan can reach, and a longer run of them
 * is not a rank this service issued.
 */
const WINDOW_RANK_PATTERN = /^\d{1,10}$/u;

const parseWindowStart = (value: string): number | null =>
  WINDOW_RANK_PATTERN.test(value) ? Number(value) : null;

/** The order segment, read against the declared list rather than a pattern. */
const parseSearchSort = (value: string): SearchSort | null =>
  SEARCH_SORTS.find((sort) => sort === value) ?? null;

export const encodeCorpusSearchCursor = ({
  dictionary,
  id,
  score,
  sort,
  windowStart,
}: CorpusSearchCursor): string =>
  encodeCursor(
    score,
    `${windowStart}:${serializeExpansionDictionaryIdentity(dictionary)}:${sort}:${id}`,
  );

export const decodeCorpusSearchCursor = (
  cursor: string,
): CorpusSearchCursor | null => {
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    return null;
  }
  const segments = decoded.id.split(":");
  const id = segments.at(-1);
  if (id === undefined || id.length === 0) {
    return null;
  }
  const cursorOf = (
    dictionary: ExpansionDictionaryIdentity,
    windowStart: number,
    sort: SearchSort,
  ): CorpusSearchCursor => ({
    dictionary,
    id,
    score: decoded.score,
    sort,
    windowStart,
  });

  switch (segments.length) {
    // legacy: `<score>:<id>`.
    case 1: {
      return cursorOf(NO_EXPANSION_DICTIONARY_IDENTITY, 0, DEFAULT_SEARCH_SORT);
    }
    // legacy: `<score>:<windowStart>:<id>`.
    case 2: {
      const windowStart = parseWindowStart(segments.at(0) ?? "");
      return windowStart === null
        ? null
        : cursorOf(
            NO_EXPANSION_DICTIONARY_IDENTITY,
            windowStart,
            DEFAULT_SEARCH_SORT,
          );
    }
    // legacy: `<score>:<windowStart>:<dictionary>:<id>`.
    case 3: {
      const windowStart = parseWindowStart(segments.at(0) ?? "");
      const dictionary = parseExpansionDictionaryIdentity(segments.at(1) ?? "");
      if (windowStart === null || dictionary === null) {
        return null;
      }
      return cursorOf(dictionary, windowStart, DEFAULT_SEARCH_SORT);
    }
    case 4: {
      const windowStart = parseWindowStart(segments.at(0) ?? "");
      const dictionary = parseExpansionDictionaryIdentity(segments.at(1) ?? "");
      const sort = parseSearchSort(segments.at(2) ?? "");
      if (windowStart === null || dictionary === null || sort === null) {
        return null;
      }
      return cursorOf(dictionary, windowStart, sort);
    }
    // An id carrying a colon is not a cursor this service issued: the grammar
    // above spends every segment it defines, so a longer payload is malformed
    // rather than an id with a separator in it.
    default: {
      return null;
    }
  }
};

/** What a continuation must agree with the cursor about. */
type CorpusSearchRanking = {
  dictionary: ExpansionDictionaryIdentity;
  sort: SearchSort;
};

/**
 * Whether this cursor may not be continued against `ranking`. The one owner
 * of the rule: both corpus read paths ask it, and each turns a true into the
 * rejection its own boundary speaks (an HTTP 400, or the error above).
 */
export const isStaleCorpusSearchCursor = (
  cursor: CorpusSearchCursor | null,
  { dictionary, sort }: CorpusSearchRanking,
): boolean =>
  cursor !== null &&
  (!sameExpansionDictionary(cursor.dictionary, dictionary) ||
    cursor.sort !== sort);
