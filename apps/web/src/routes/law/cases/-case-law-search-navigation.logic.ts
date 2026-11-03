import { withPendingQuery } from "@/features/case-law/case-law-index-search.logic";

import type { CaseLawIndexSearch } from "./-case-law-search-schema";

/**
 * Every change the case-law index makes to its search, and whether it
 * retires the notice of filters a country left out. A change of the filters
 * does; any other keeps it, because the filters it names stay absent and the
 * reader has not dismissed it.
 */
export const SEARCH_CHANGE_RETIRES_FILTER_NOTICE = {
  "page-size": false,
  strict: false,
  filter: true,
  "date-range": true,
  "clear-filters": true,
  refine: false,
  sort: false,
  "auto-refine": false,
  "original-words": false,
} as const satisfies Record<string, boolean>;

export type CaseLawSearchChange =
  keyof typeof SEARCH_CHANGE_RETIRES_FILTER_NOTICE;

type NextCaseLawIndexSearchOptions = {
  previous: CaseLawIndexSearch;
  /** Text typed into the box that the URL has not seen yet. */
  pendingQuery: string | null;
  change: CaseLawSearchChange;
  apply: (search: CaseLawIndexSearch) => CaseLawIndexSearch;
};

/**
 * The search after one change: the pending text folded in first, the page
 * dropped (page 3 of the old result set names nothing in the new one), and
 * the filter notice kept unless the change retires it.
 */
export const nextCaseLawIndexSearch = ({
  previous,
  pendingQuery,
  change,
  apply,
}: NextCaseLawIndexSearchOptions): CaseLawIndexSearch =>
  apply({
    ...withPendingQuery(previous, pendingQuery),
    page: undefined,
    filterNotice: SEARCH_CHANGE_RETIRES_FILTER_NOTICE[change]
      ? undefined
      : previous.filterNotice,
  });
