/**
 * The wire format of a corpus-index search cursor: its one owner.
 *
 * A page boundary is only meaningful inside the ranking that produced it, and
 * two things decide that ranking. The scan window fixes which slice of the
 * engine's order was ranked, so a continuation has to resume in the same
 * window or rank a different slice against the page's boundary. Under
 * `QUERY_EXPANSION_MODE="on"` the engine query itself is a function of the
 * dictionary the serving replica had loaded, so two replicas mid-rebuild build
 * two different queries from one request. Either mismatch skips or repeats
 * decisions behind an ordinary-looking page.
 *
 * Both therefore travel in the cursor, which is the only thing that survives
 * between the two requests, and one codec owns them: a second module encoding
 * part of this string is a second answer to what a page boundary means.
 *
 * Current form, inside the shared `(score, id)` framing:
 *
 *     base64("<score>:<windowStart>:<dictionary>:<id>")
 *
 * `windowStart` is a decimal rank, `dictionary` is a payload's sha256 hex or
 * `none`, and `id` is one segment — the corpus addresses documents by uuid, so
 * the grammar is fixed-width in its metadata and needs no escaping rule.
 *
 * REMOVAL CONDITION: delete `legacy` handling in `decodeCorpusSearchCursor`
 * in the release after the next one, once no replica issuing a shorter form
 * can still be serving.
 *
 * Two shorter forms were issued to clients before this one, and a rolling
 * deploy hands them back mid-pagination, so both are read rather than
 * rejected. Their identity is `none` soundly, not as a courtesy: neither
 * release could run the expanded query at all, so the page each bounds came
 * from the unexpanded one, which is exactly what `none` means.
 *
 *   - `<score>:<id>` predates windows and expansion, and window 0 is where a
 *     scan with no window began.
 *   - `<score>:<windowStart>:<id>` predates expansion only, so its window is
 *     read as written.
 *
 * One metadata segment therefore means a window rank and nothing else.
 */

import { TaggedError } from "better-result";

import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  type ExpansionDictionaryIdentity,
  NO_EXPANSION_DICTIONARY_IDENTITY,
  parseExpansionDictionaryIdentity,
  sameExpansionDictionary,
  serializeExpansionDictionaryIdentity,
} from "@/api/lib/legal-search/morphology/dictionary";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

/**
 * The scan's own boundary plus the dictionary that built the query it ranked.
 * Derived from `SearchCursor` rather than restated, so a field the scan starts
 * carrying cannot go missing from the format that has to survive the request.
 */
export type CorpusSearchCursor = SearchCursor & {
  dictionary: ExpansionDictionaryIdentity;
};

/**
 * Why a cursor cannot be continued: it did not decode at all, or it names a
 * dictionary other than the one this request resolved. Named rather than
 * flagged, because both answers are "start over" to a client and only the
 * reason tells an operator which.
 */
export type InvalidCorpusSearchCursorReason =
  | "dictionary_mismatch"
  | "undecodable";

/**
 * A continuation page cannot be served for the cursor it was asked with. Read
 * paths without an HTTP status of their own fail on this rather than restarting
 * at page one, which a client that appends pages reads as duplicates.
 */
export class InvalidCorpusSearchCursorError extends TaggedError(
  "InvalidCorpusSearchCursorError",
)<{
  message: string;
  reason: InvalidCorpusSearchCursorReason;
}> {}

/**
 * A window rank on the wire: decimal digits, bounded so the parse is total.
 * Ten digits is far above any rank a scan can reach, and a longer run of them
 * is not a rank this service issued.
 */
const WINDOW_RANK_PATTERN = /^\d{1,10}$/u;

const parseWindowStart = (value: string): number | null =>
  WINDOW_RANK_PATTERN.test(value) ? Number(value) : null;

export const encodeCorpusSearchCursor = ({
  dictionary,
  id,
  score,
  windowStart,
}: CorpusSearchCursor): string =>
  encodeCursor(
    score,
    `${windowStart}:${serializeExpansionDictionaryIdentity(dictionary)}:${id}`,
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
  ): CorpusSearchCursor => ({
    dictionary,
    id,
    score: decoded.score,
    windowStart,
  });

  switch (segments.length) {
    // legacy: `<score>:<id>`.
    case 1: {
      return cursorOf(NO_EXPANSION_DICTIONARY_IDENTITY, 0);
    }
    // legacy: `<score>:<windowStart>:<id>`.
    case 2: {
      const windowStart = parseWindowStart(segments.at(0) ?? "");
      return windowStart === null
        ? null
        : cursorOf(NO_EXPANSION_DICTIONARY_IDENTITY, windowStart);
    }
    case 3: {
      const windowStart = parseWindowStart(segments.at(0) ?? "");
      const dictionary = parseExpansionDictionaryIdentity(segments.at(1) ?? "");
      if (windowStart === null || dictionary === null) {
        return null;
      }
      return cursorOf(dictionary, windowStart);
    }
    // An id carrying a colon is not a cursor this service issued: the grammar
    // above spends every segment it defines, so a longer payload is malformed
    // rather than an id with a separator in it.
    default: {
      return null;
    }
  }
};

/**
 * Whether this cursor may not be continued against `dictionary`. The one
 * owner of the rule: both corpus read paths ask it, and each turns a true
 * into the rejection its own boundary speaks (an HTTP 400, or the error
 * above).
 */
export const isStaleCorpusSearchCursor = (
  cursor: CorpusSearchCursor | null,
  dictionary: ExpansionDictionaryIdentity,
): boolean =>
  cursor !== null && !sameExpansionDictionary(cursor.dictionary, dictionary);
