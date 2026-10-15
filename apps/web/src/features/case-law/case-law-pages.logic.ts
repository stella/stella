import { panic } from "better-result";

import { SEARCH_PAGE_END } from "@stll/api-contract/search";

import { PUBLIC_LAW_PAGE_REST } from "@/components/public-law-table/public-law-pagination.logic";
import type { PublicLawPageRest } from "@/components/public-law-table/public-law-pagination.logic";
import type { PublicLawRowsPhase } from "@/components/public-law-table/public-law-results-state.logic";

export * from "@/features/case-law/case-law-route-pages.logic";

type CaseLawPageAnswer = {
  end: (typeof SEARCH_PAGE_END)[keyof typeof SEARCH_PAGE_END];
};

type CaseLawPageRestInput = {
  /** The page query's data; it may still be another page's while one loads. */
  page: CaseLawPageAnswer | undefined;
  rows: PublicLawRowsPhase;
};

/**
 * What follows the page on screen, read only from that page's own answer:
 * rows kept from another page while this one loads say nothing about it, and
 * neither does a page whose scan stopped on a budget.
 */
export const caseLawPageRest = ({
  page,
  rows,
}: CaseLawPageRestInput): PublicLawPageRest => {
  if (rows !== "rows" || page === undefined) {
    return PUBLIC_LAW_PAGE_REST.unknown;
  }
  switch (page.end) {
    case SEARCH_PAGE_END.MORE:
      return PUBLIC_LAW_PAGE_REST.more;
    case SEARCH_PAGE_END.COMPLETE:
      return PUBLIC_LAW_PAGE_REST.end;
    case SEARCH_PAGE_END.STOPPED:
      return PUBLIC_LAW_PAGE_REST.unknown;
    default:
      page.end satisfies never;
      return panic("Unhandled page end");
  }
};
