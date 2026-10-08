import { panic, Result } from "better-result";
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
 * and, for a read that reaches a group under a contract of its own, the
 * identity of what it reached before the id:
 *
 *     base64("<score>:<windowStart>:<dictionary>:<sort>:<target>:<id>")
 *
 * A cursor without a target was built against groups under their manifests'
 * contracts only, so it cannot continue a read whose target has one.
 *
 * Four more optional segments may follow the target, always in this order
 * and each at most once:
 *
 *     base64("<score>:<windowStart>:<dictionary>:<sort>[:<target>][:x<tokens>][:p<phase>][:r-<mode>][:n<depth>]:<id>")
 *
 *   - `x<tokens>`: a continuation that moved past a capped scan window of a
 *     ranker that folds hits into groups carries the groups earlier windows
 *     showed (`SearchCursor.excludedGroups`) as fixed-width group tokens;
 *     absent when there are none.
 *   - `p<phase>`: legislation carries base64url JSON for its strict or relaxed
 *     phase, query fingerprint, serving generation and, for relaxed results,
 *     the strict Works already returned. It is unauthenticated like the
 *     enclosing cursor; continuation validation compares its phase identity
 *     with the current request before using it. Postgres legislation reads
 *     use the same strict phase with a null generation, so the request stays
 *     bound without a serving corpus index.
 *   - `r-<mode>`: an experimental session carries `r-off` or `r-bm25-ratio`.
 *     The effective mode survives fallback and every continuation; existing
 *     position cursors omit it and remain position cursors.
 *   - `n<depth>`: a cursor descending from a page addressed by offset carries
 *     how many results its window ranks ahead of it
 *     (`SearchCursor.replayDepth`), so the continuation replays the window as
 *     deep as that page did. It lives in the first window only, where no
 *     group has been excluded yet, so it never travels with `x<tokens>` and
 *     the bound with groups covers it.
 *
 * Each optional segment is identified by its opening characters: a target is
 * lowercase hex, and `x`, `p`, `r` and `n` are not hex digits nor prefixes of each
 * other, so no segment reads as another. A repeated or out-of-order segment
 * is malformed. A replica that predates a segment refuses such a cursor as
 * malformed rather than misreading it.
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
import { createHash } from "node:crypto";
import * as v from "valibot";

import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import {
  CORPUS_INDEX_RANKING_MODES,
  type CorpusIndexRankingMode,
} from "@/api/lib/legal-search/corpus-ranking-policy";
import {
  DEFAULT_SEARCH_SORT,
  SEARCH_SORTS,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";
import {
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  isCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";
import {
  type ExpansionDictionaryIdentity,
  NO_EXPANSION_DICTIONARY_IDENTITY,
  parseExpansionDictionaryIdentity,
  sameExpansionDictionary,
  serializeExpansionDictionaryIdentity,
} from "@/api/lib/legal-search/morphology/dictionary";
import { LIMITS } from "@/api/lib/limits";
import { decodeCursor, encodeCursor } from "@/api/lib/search/cursor";

/**
 * The scan's own boundary plus the dictionary that built the query it ranked
 * and the order it ranked in. Derived from `SearchCursor` rather than
 * restated, so a field the scan starts carrying cannot go missing from the
 * format that has to survive the request.
 */
export type CorpusSearchCursor = SearchCursor & {
  dictionary: ExpansionDictionaryIdentity;
  /**
   * The identity of what the read reached (`corpusIndexReadTarget`), or null
   * for a read that reached only groups under their manifests' contracts,
   * whose cursors keep the form they always had.
   */
  target: string | null;
  phase?: CorpusSearchPhase | undefined;
};

/** Hex characters of a read target's identity (`corpusIndexReadTarget`). */
export const CORPUS_READ_TARGET_IDENTITY_LENGTH = 32;

/** A read target identity on the wire: fixed-width lowercase hex. */
const READ_TARGET_PATTERN = new RegExp(
  `^[0-9a-f]{${String(CORPUS_READ_TARGET_IDENTITY_LENGTH)}}$`,
  "u",
);

/**
 * A window rank on the wire: decimal digits, bounded so the parse is total.
 * Ten digits is far above any rank a scan can reach, and a longer run of them
 * is not a rank this service issued.
 */
const WINDOW_RANK_PATTERN = /^\d{1,10}$/u;

/** Characters of one excluded-group token: base64url, fixed width. */
export const CORPUS_CURSOR_GROUP_TOKEN_CHARS = 6;
/** Fixed-width identity shared by every ranker and the cursor codec. */
export const corpusSearchGroupToken = (key: string): string =>
  createHash("sha256")
    .update(key)
    .digest("base64url")
    .slice(0, CORPUS_CURSOR_GROUP_TOKEN_CHARS);

const GROUP_TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${String(CORPUS_CURSOR_GROUP_TOKEN_CHARS)}}$`,
  "u",
);
const GROUPS_SEGMENT_PREFIX = "x";
const RANKING_MODE_PREFIX = "r-";
const RANKING_MODE_MAX_CHARS =
  RANKING_MODE_PREFIX.length +
  Math.max(...CORPUS_INDEX_RANKING_MODES.map((mode) => mode.length));
const PHASE_SEGMENT_PREFIX = "p";
const REPLAY_DEPTH_PREFIX = "n";
/** A replay depth on the wire: a decimal count, bounded like a window rank. */
const REPLAY_DEPTH_PATTERN = /^n(\d{1,10})$/u;
const PHASE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

const phaseIdentityFields = {
  fingerprint: v.pipe(v.string(), v.regex(PHASE_FINGERPRINT_PATTERN)),
  generation: v.pipe(v.string(), v.check(isCorpusIndexGeneration)),
};
const corpusSearchPhaseSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("strict"),
    ...phaseIdentityFields,
    // Postgres has no serving index generation, but shares request binding.
    generation: v.nullable(phaseIdentityFields.generation),
  }),
  v.strictObject({
    type: v.literal("relaxed"),
    ...phaseIdentityFields,
    strictWorkTokens: v.pipe(
      v.array(v.pipe(v.string(), v.regex(GROUP_TOKEN_PATTERN))),
      v.maxLength(LIMITS.corpusIndexSearchMaxExcludedGroups),
      v.check((tokens) => new Set(tokens).size === tokens.length),
      v.readonly(),
    ),
  }),
]);
export type CorpusSearchPhase = v.InferOutput<typeof corpusSearchPhaseSchema>;

const readPhase = (value: unknown): CorpusSearchPhase | null => {
  const result = v.safeParse(corpusSearchPhaseSchema, value);
  return result.success ? result.output : null;
};

const serializePhase = (phase: CorpusSearchPhase): string => {
  const validated = readPhase(phase);
  if (validated === null) {
    return panic("A search phase does not satisfy the corpus cursor grammar");
  }
  return `${PHASE_SEGMENT_PREFIX}${Buffer.from(JSON.stringify(validated)).toString("base64url")}`;
};

/** The excluded-groups segment, or null when there is nothing to carry. */
const serializeExcludedGroups = (
  groups: readonly string[] | undefined,
): string | null => {
  if (groups === undefined || groups.length === 0) {
    return null;
  }
  for (const group of groups) {
    if (!GROUP_TOKEN_PATTERN.test(group)) {
      return panic("An excluded group is not a cursor group token");
    }
  }
  return `${GROUPS_SEGMENT_PREFIX}${groups.join("")}`;
};

/** The groups a segment carries, or null for one this service did not issue. */
const parseExcludedGroups = (value: string): string[] | null => {
  if (!value.startsWith(GROUPS_SEGMENT_PREFIX)) {
    return null;
  }
  const tokens = value.slice(GROUPS_SEGMENT_PREFIX.length);
  const count = tokens.length / CORPUS_CURSOR_GROUP_TOKEN_CHARS;
  if (
    count < 1 ||
    !Number.isInteger(count) ||
    count > LIMITS.corpusIndexSearchMaxExcludedGroups
  ) {
    return null;
  }
  const groups = Array.from({ length: count }, (_, index) =>
    tokens.slice(
      index * CORPUS_CURSOR_GROUP_TOKEN_CHARS,
      (index + 1) * CORPUS_CURSOR_GROUP_TOKEN_CHARS,
    ),
  );
  return groups.every((group) => GROUP_TOKEN_PATTERN.test(group))
    ? groups
    : null;
};

const parseWindowStart = (value: string): number | null =>
  WINDOW_RANK_PATTERN.test(value) ? Number(value) : null;

/** The order segment, read against the declared list rather than a pattern. */
const parseSearchSort = (value: string): SearchSort | null =>
  SEARCH_SORTS.find((sort) => sort === value) ?? null;

/**
 * The longest cursor this grammar can emit, in characters.
 *
 * Derived from the segments rather than measured, because a caller that has to
 * declare a cursor input's maximum length has to be told by the grammar's own
 * owner: a smaller cap rejects a page boundary this service legitimately
 * issued, and the caller finds out only when a second page is refused. Under
 * query expansion the dictionary identity alone is a 64-character sha256, so
 * the emitted length is not a round number anyone should guess.
 */
// Fixed notation just above 1e-6 can be longer than scientific notation:
// -0.0000012345678901234567 occupies 25 characters.
const SCORE_MAX_CHARS = 25;
const WINDOW_RANK_MAX_CHARS = 10;
const DICTIONARY_IDENTITY_MAX_CHARS = 64;
const DECISION_ID_MAX_CHARS = 36;
const SORT_MAX_CHARS = Math.max(...SEARCH_SORTS.map((sort) => sort.length));
/** Four base64 characters per three bytes, rounded up to a whole group. */
const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4;
const PHASE_SEGMENT_MAX_CHARS =
  PHASE_SEGMENT_PREFIX.length +
  base64Length(
    JSON.stringify({
      type: "relaxed",
      fingerprint: "a".repeat(DICTIONARY_IDENTITY_MAX_CHARS),
      generation: "a".repeat(CORPUS_INDEX_GENERATION_MAX_LENGTH),
      strictWorkTokens: Array.from(
        { length: LIMITS.corpusIndexSearchMaxExcludedGroups },
        () => "a".repeat(CORPUS_CURSOR_GROUP_TOKEN_CHARS),
      ),
    }).length,
  );

const parsePhase = (segment: string): CorpusSearchPhase | null => {
  if (segment.length > PHASE_SEGMENT_MAX_CHARS) {
    return null;
  }
  const payload = segment.slice(PHASE_SEGMENT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) {
    return null;
  }
  const decoded = Buffer.from(payload, "base64url");
  if (decoded.toString("base64url") !== payload) {
    return null;
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(decoded.toString("utf-8")),
    catch: () => undefined,
  });
  return Result.isError(parsed) ? null : readPhase(parsed.value);
};

const GROUPS_SEGMENT_MAX_CHARS =
  GROUPS_SEGMENT_PREFIX.length +
  LIMITS.corpusIndexSearchMaxExcludedGroups * CORPUS_CURSOR_GROUP_TOKEN_CHARS;

/**
 * The longest framed payload without groups or a phase: every fixed segment,
 * a read target and a ranking mode, each at its bound and followed by its
 * separator.
 */
const BASE_PAYLOAD_MAX_CHARS =
  SCORE_MAX_CHARS +
  1 +
  WINDOW_RANK_MAX_CHARS +
  1 +
  DICTIONARY_IDENTITY_MAX_CHARS +
  1 +
  SORT_MAX_CHARS +
  1 +
  CORPUS_READ_TARGET_IDENTITY_LENGTH +
  1 +
  RANKING_MODE_MAX_CHARS +
  1 +
  DECISION_ID_MAX_CHARS;

export const CORPUS_SEARCH_CURSOR_MAX_LENGTH = base64Length(
  BASE_PAYLOAD_MAX_CHARS,
);

/**
 * The longest cursor that carries excluded groups: the form above plus the
 * groups segment at its bound. Only a search whose ranker folds hits into
 * groups can issue one, so only such a search's cursor input declares it.
 */
export const CORPUS_SEARCH_CURSOR_WITH_GROUPS_MAX_LENGTH = base64Length(
  BASE_PAYLOAD_MAX_CHARS + GROUPS_SEGMENT_MAX_CHARS + 1,
);

/** Legislation's cursor: the groups form plus the phase segment at its bound. */
export const CORPUS_SEARCH_CURSOR_WITH_PHASE_MAX_LENGTH = base64Length(
  BASE_PAYLOAD_MAX_CHARS +
    GROUPS_SEGMENT_MAX_CHARS +
    1 +
    PHASE_SEGMENT_MAX_CHARS +
    1,
);

export const encodeCorpusSearchCursor = ({
  dictionary,
  excludedGroups,
  id,
  score,
  sort,
  target,
  windowStart,
  phase,
  rankingMode,
  replayDepth,
}: CorpusSearchCursor): string => {
  const groups = serializeExcludedGroups(excludedGroups);
  if (
    replayDepth !== undefined &&
    (groups !== null ||
      !Number.isInteger(replayDepth) ||
      replayDepth < 1 ||
      !REPLAY_DEPTH_PATTERN.test(`${REPLAY_DEPTH_PREFIX}${replayDepth}`))
  ) {
    return panic(
      "A replay depth is a positive count carried only in the first window",
    );
  }
  return encodeCursor(
    score,
    `${windowStart}:${serializeExpansionDictionaryIdentity(dictionary)}:${sort}:${target === null ? "" : `${target}:`}${groups === null ? "" : `${groups}:`}${phase === undefined ? "" : `${serializePhase(phase)}:`}${rankingMode === undefined ? "" : `${RANKING_MODE_PREFIX}${rankingMode}:`}${replayDepth === undefined ? "" : `${REPLAY_DEPTH_PREFIX}${replayDepth}:`}${id}`,
  );
};

/** What the segments before the id say about the ranking a page came from. */
type CursorRanking = Pick<
  SearchCursor,
  "windowStart" | "sort" | "rankingMode" | "excludedGroups" | "replayDepth"
> & {
  dictionary: ExpansionDictionaryIdentity;
  target?: string | null;
  phase?: CorpusSearchPhase | undefined;
};

type OptionalSegments = {
  target: string | null;
  excludedGroups: readonly string[];
  phase?: CorpusSearchPhase | undefined;
  rankingMode?: CorpusIndexRankingMode | undefined;
  replayDepth?: number | undefined;
};

/**
 * The optional segments in the only order the encoder writes them. Each kind
 * is told apart by its first characters (lowercase hex, `x`, `p`, `r-`), none
 * of which opens another, so a segment's kind never depends on its position.
 */
const OPTIONAL_SEGMENT_KINDS = [
  "target",
  "groups",
  "phase",
  "rankingMode",
  "replayDepth",
] as const;
type OptionalSegmentKind = (typeof OPTIONAL_SEGMENT_KINDS)[number];

const optionalSegmentKind = (segment: string): OptionalSegmentKind | null => {
  if (READ_TARGET_PATTERN.test(segment)) {
    return "target";
  }
  if (segment.startsWith(GROUPS_SEGMENT_PREFIX)) {
    return "groups";
  }
  if (segment.startsWith(PHASE_SEGMENT_PREFIX)) {
    return "phase";
  }
  if (segment.startsWith(RANKING_MODE_PREFIX)) {
    return "rankingMode";
  }
  if (segment.startsWith(REPLAY_DEPTH_PREFIX)) {
    return "replayDepth";
  }
  return null;
};

const parseReplayDepth = (segment: string): number | null => {
  const digits = REPLAY_DEPTH_PATTERN.exec(segment)?.at(1);
  if (digits === undefined) {
    return null;
  }
  const depth = Number(digits);
  return depth >= 1 ? depth : null;
};

const parseRankingMode = (segment: string): CorpusIndexRankingMode | null =>
  CORPUS_INDEX_RANKING_MODES.find(
    (mode) => `${RANKING_MODE_PREFIX}${mode}` === segment,
  ) ?? null;

/**
 * The optional segments after the sort: any subset of target, groups, phase
 * and ranking mode, each at most once and in that order. Null otherwise, so a
 * repeated or reordered segment is malformed rather than silently resolved.
 */
const parseOptionalSegments = (
  segments: readonly string[],
): OptionalSegments | null => {
  const parsed: OptionalSegments = { target: null, excludedGroups: [] };
  let previousRank = -1;
  for (const segment of segments) {
    const kind = optionalSegmentKind(segment);
    if (kind === null) {
      return null;
    }
    const rank = OPTIONAL_SEGMENT_KINDS.indexOf(kind);
    if (rank <= previousRank) {
      return null;
    }
    previousRank = rank;
    switch (kind) {
      case "target": {
        parsed.target = segment;
        break;
      }
      case "groups": {
        const excludedGroups = parseExcludedGroups(segment);
        if (excludedGroups === null) {
          return null;
        }
        parsed.excludedGroups = excludedGroups;
        break;
      }
      case "phase": {
        const phase = parsePhase(segment);
        if (phase === null) {
          return null;
        }
        parsed.phase = phase;
        break;
      }
      case "rankingMode": {
        const rankingMode = parseRankingMode(segment);
        if (rankingMode === null) {
          return null;
        }
        parsed.rankingMode = rankingMode;
        break;
      }
      case "replayDepth": {
        const replayDepth = parseReplayDepth(segment);
        // Only the first window carries a depth, and no group is excluded
        // there yet.
        if (replayDepth === null || parsed.excludedGroups.length > 0) {
          return null;
        }
        parsed.replayDepth = replayDepth;
        break;
      }
      default: {
        kind satisfies never;
        return panic("Unhandled corpus cursor segment kind");
      }
    }
  }
  return parsed;
};

/** `<windowStart>:<dictionary>:<sort>[:<target>][:x<groups>][:p<phase>][:r-<mode>][:n<depth>]`. */
const parseCurrentForm = (
  segments: readonly string[],
): CursorRanking | null => {
  const windowStart = parseWindowStart(segments.at(0) ?? "");
  const dictionary = parseExpansionDictionaryIdentity(segments.at(1) ?? "");
  const sort = parseSearchSort(segments.at(2) ?? "");
  const optional = parseOptionalSegments(segments.slice(3));
  if (
    windowStart === null ||
    dictionary === null ||
    sort === null ||
    optional === null
  ) {
    return null;
  }
  const { phase, rankingMode, replayDepth, ...rest } = optional;
  if (replayDepth !== undefined && windowStart !== 0) {
    return null;
  }
  return {
    dictionary,
    windowStart,
    sort,
    ...rest,
    ...(phase === undefined ? {} : { phase }),
    ...(rankingMode === undefined ? {} : { rankingMode }),
    ...(replayDepth === undefined ? {} : { replayDepth }),
  };
};

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
  const cursorOf = ({
    excludedGroups = [],
    target = null,
    ...ranking
  }: CursorRanking): CorpusSearchCursor => ({
    ...ranking,
    id,
    score: decoded.score,
    target,
    ...(excludedGroups.length === 0 ? {} : { excludedGroups }),
  });

  switch (segments.length) {
    // legacy: `<score>:<id>`.
    case 1: {
      return cursorOf({
        dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
        windowStart: 0,
        sort: DEFAULT_SEARCH_SORT,
      });
    }
    // legacy: `<score>:<windowStart>:<id>`.
    case 2: {
      const windowStart = parseWindowStart(segments.at(0) ?? "");
      return windowStart === null
        ? null
        : cursorOf({
            dictionary: NO_EXPANSION_DICTIONARY_IDENTITY,
            windowStart,
            sort: DEFAULT_SEARCH_SORT,
          });
    }
    // legacy: `<score>:<windowStart>:<dictionary>:<id>`.
    case 3: {
      const windowStart = parseWindowStart(segments.at(0) ?? "");
      const dictionary = parseExpansionDictionaryIdentity(segments.at(1) ?? "");
      if (windowStart === null || dictionary === null) {
        return null;
      }
      return cursorOf({ dictionary, windowStart, sort: DEFAULT_SEARCH_SORT });
    }
    // The current form, with any ordered subset of the optional segments
    // (groups and a replay depth never travel together).
    case 4:
    case 5:
    case 6:
    case 7:
    case 8: {
      const ranking = parseCurrentForm(segments.slice(0, -1));
      return ranking === null ? null : cursorOf(ranking);
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
  /** The read's target identity; a cursor must carry exactly this one. */
  target: string | null;
  phase?: CorpusSearchPhase | undefined;
};

/**
 * Whether this cursor may not be continued against `ranking`. The one owner
 * of the rule: both corpus read paths ask it, and each turns a true into the
 * rejection its own boundary speaks (an HTTP 400, or the error above).
 */
export const isStaleCorpusSearchCursor = (
  cursor: CorpusSearchCursor | null,
  { dictionary, sort, target, phase }: CorpusSearchRanking,
): boolean =>
  cursor !== null &&
  (!sameExpansionDictionary(cursor.dictionary, dictionary) ||
    cursor.sort !== sort ||
    cursor.target !== target ||
    cursor.phase?.type !== phase?.type ||
    cursor.phase?.fingerprint !== phase?.fingerprint ||
    cursor.phase?.generation !== phase?.generation);
