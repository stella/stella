import type { SearchPaginationOutcome } from "@stll/api-contract/search";

import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import type {
  CorpusSearchCursor,
  CorpusSearchPhase,
} from "@/api/lib/legal-search/corpus-search-cursor";
import {
  DEFAULT_SEARCH_SORT,
  type SearchSort,
} from "@/api/lib/legal-search/corpus-search-order";

const RELAXED_START_ID = "00000000-0000-0000-0000-000000000000";

export type TwoPhaseSearchPage<Hit> = {
  hits: readonly Hit[];
  nextCursor: SearchCursor | null;
  paginationOutcome: SearchPaginationOutcome;
};

/** The hit type a page carries: inferred from the page, never given apart. */
type HitOf<Page extends TwoPhaseSearchPage<unknown>> = Page["hits"][number];

type TwoPhaseSearchOptions<Page extends TwoPhaseSearchPage<unknown>> = {
  /**
   * The strict read begins at the first result. Only that read may top up:
   * a later page (by cursor or by offset) cannot know which strict hits the
   * pages before it already showed, so a top-up there could repeat them.
   */
  atStart: boolean;
  cursor: CorpusSearchCursor | null;
  fingerprint: string;
  generation: string;
  limit: number;
  /**
   * The order the reader asked for. Any-word matches are ranked by relevance
   * only: mixed into a date order they would interleave partial matches with
   * exact ones by date, so another order never tops up.
   */
  sort: SearchSort;
  strictOnly: boolean;
  read: (
    phase: CorpusSearchPhase,
    limit: number,
    cursor: SearchCursor | null,
  ) => Promise<Page | null>;
  encodeCursor: (page: Page, phase: CorpusSearchPhase) => string | null;
  groupToken: (hit: HitOf<Page>, page: Page) => string;
  hitId: (hit: HitOf<Page>) => string;
};

export type TwoPhaseSearchResult<Page extends TwoPhaseSearchPage<unknown>> = {
  hits: HitOf<Page>[];
  pages: readonly Page[];
  nextCursor: string | null;
  paginationOutcome: SearchPaginationOutcome;
  relaxedHitCount: number;
  relaxedShown: boolean;
};

/**
 * Runs an exhausted strict first page into a deduplicated relaxed phase. The
 * relaxed phase keeps the engine's order on every page: its any-word score
 * already grows with each matched term, and a cursor continues that order, so
 * no page re-ranks what another page cannot.
 */
export const runTwoPhaseSearch = async <
  Page extends TwoPhaseSearchPage<unknown>,
>({
  atStart,
  cursor,
  fingerprint,
  generation,
  limit,
  sort,
  strictOnly,
  read,
  encodeCursor,
  groupToken,
  hitId,
}: TwoPhaseSearchOptions<Page>): Promise<TwoPhaseSearchResult<Page>> => {
  const phase = cursor?.phase ?? { type: "strict", fingerprint, generation };
  const page = await read(phase, limit, cursor);
  if (page === null) {
    return {
      hits: [],
      pages: [],
      nextCursor: null,
      paginationOutcome: { type: "complete" },
      relaxedHitCount: 0,
      relaxedShown: false,
    };
  }
  const hits = [...page.hits];
  if (
    phase.type === "relaxed" ||
    strictOnly ||
    !atStart ||
    sort !== DEFAULT_SEARCH_SORT ||
    cursor !== null ||
    hits.length >= limit ||
    page.nextCursor !== null ||
    page.paginationOutcome.type === "truncated"
  ) {
    return {
      hits,
      pages: [page],
      nextCursor: encodeCursor(page, phase),
      paginationOutcome: page.paginationOutcome,
      relaxedHitCount: phase.type === "relaxed" ? hits.length : 0,
      relaxedShown: phase.type === "relaxed" && hits.length > 0,
    };
  }

  const relaxed: CorpusSearchPhase = {
    type: "relaxed",
    fingerprint,
    generation,
    strictWorkTokens: [...new Set(hits.map((hit) => groupToken(hit, page)))],
  };
  const boundary: SearchCursor = {
    score: Number.MAX_VALUE,
    id: RELAXED_START_ID,
    sort: DEFAULT_SEARCH_SORT,
    windowStart: 0,
  };
  const extra = await read(relaxed, limit - hits.length, boundary);
  if (extra === null) {
    return {
      hits,
      pages: [page],
      nextCursor: null,
      paginationOutcome: page.paginationOutcome,
      relaxedHitCount: 0,
      relaxedShown: false,
    };
  }
  const seen = new Set(hits.map(hitId));
  const relaxedHits = extra.hits
    .filter((hit) => !seen.has(hitId(hit)))
    .slice(0, limit - hits.length);
  return {
    hits: [...hits, ...relaxedHits],
    pages: [page, extra],
    nextCursor: encodeCursor(extra, relaxed),
    paginationOutcome: extra.paginationOutcome,
    relaxedHitCount: relaxedHits.length,
    relaxedShown: relaxedHits.length > 0,
  };
};
