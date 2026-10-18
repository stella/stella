import type { SearchPaginationOutcome } from "@stll/api-contract/search";

import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import type {
  CorpusSearchCursor,
  CorpusSearchPhase,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { DEFAULT_SEARCH_SORT } from "@/api/lib/legal-search/corpus-search-order";

const RELAXED_START_ID = "00000000-0000-0000-0000-000000000000";

export type TwoPhaseSearchPage<Hit> = {
  hits: readonly Hit[];
  nextCursor: SearchCursor | null;
  paginationOutcome: SearchPaginationOutcome;
};

type TwoPhaseSearchOptions<Page extends TwoPhaseSearchPage<Hit>, Hit> = {
  cursor: CorpusSearchCursor | null;
  fingerprint: string;
  generation: string;
  limit: number;
  strictOnly: boolean;
  read: (
    phase: CorpusSearchPhase,
    limit: number,
    cursor: SearchCursor | null,
  ) => Promise<Page | null>;
  encodeCursor: (page: Page, phase: CorpusSearchPhase) => string | null;
  groupToken: (hit: Hit, page: Page) => string;
  hitId: (hit: Hit) => string;
  relaxedCoverage: (hit: Hit, page: Page) => number;
  score: (hit: Hit) => number;
};

export type TwoPhaseSearchResult<Page, Hit> = {
  hits: Hit[];
  pages: readonly Page[];
  nextCursor: string | null;
  paginationOutcome: SearchPaginationOutcome;
  relaxedShown: boolean;
};

/** Runs an exhausted strict first page into a deduplicated coverage-ranked phase. */
export const runTwoPhaseSearch = async <
  Page extends TwoPhaseSearchPage<Hit>,
  Hit,
>({
  cursor,
  fingerprint,
  generation,
  limit,
  strictOnly,
  read,
  encodeCursor,
  groupToken,
  hitId,
  relaxedCoverage,
  score,
}: TwoPhaseSearchOptions<Page, Hit>): Promise<
  TwoPhaseSearchResult<Page, Hit>
> => {
  const phase = cursor?.phase ?? { type: "strict", fingerprint, generation };
  const page = await read(phase, limit, cursor);
  if (page === null) {
    return {
      hits: [],
      pages: [],
      nextCursor: null,
      paginationOutcome: { type: "complete" },
      relaxedShown: false,
    };
  }
  const hits = [...page.hits];
  if (
    phase.type === "relaxed" ||
    strictOnly ||
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
      relaxedShown: false,
    };
  }
  const seen = new Set(hits.map(hitId));
  const relaxedHits = extra.hits
    .filter((hit) => !seen.has(hitId(hit)))
    .toSorted(
      (left, right) =>
        relaxedCoverage(right, extra) - relaxedCoverage(left, extra) ||
        score(right) - score(left),
    )
    .slice(0, limit - hits.length);
  return {
    hits: [...hits, ...relaxedHits],
    pages: [page, extra],
    nextCursor: encodeCursor(extra, relaxed),
    paginationOutcome: extra.paginationOutcome,
    relaxedShown: relaxedHits.length > 0,
  };
};
