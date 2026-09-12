/**
 * What the case-law results URL holds, and how it is written back out. Pure,
 * because the same rules answer three questions at once: what the loader
 * fetches, what the canonical link says, and what "clear filters" clears.
 */

export const DECISION_SORT_ORDERS = ["relevance", "newest"] as const;

export type DecisionSortOrder = (typeof DECISION_SORT_ORDERS)[number];

/**
 * Relevance, because a query is a question and the best answer belongs first.
 * Being the default is why it is absent from the URL: a link says what the
 * reader chose, not what they accepted.
 */
export const DEFAULT_DECISION_SORT: DecisionSortOrder = "relevance";

/** What the case-law results URL accepts. Every field is single-select. */
export type CaseLawIndexSearch = {
  country?: string | undefined;
  court?: string | undefined;
  lang?: string | undefined;
  q?: string | undefined;
  sort?: DecisionSortOrder | undefined;
  source?: string | undefined;
  type?: string | undefined;
  year?: string | undefined;
};

/** The filter fields, so clearing them cannot miss one that was added later. */
export const CASE_LAW_FILTER_KEYS = [
  "court",
  "lang",
  "source",
  "type",
  "year",
] as const;

export type CaseLawFilterKey = (typeof CASE_LAW_FILTER_KEYS)[number];

export const validDecisionYear = (
  year: string | undefined,
): string | undefined => (/^\d{4}$/u.test(year ?? "") ? year : undefined);

/** Every filter unset, for a country switch and for "clear filters". */
export const clearedCaseLawFilters = (): Record<
  CaseLawFilterKey,
  undefined
> => ({
  court: undefined,
  lang: undefined,
  source: undefined,
  type: undefined,
  year: undefined,
});

/**
 * The URL a navigation should start from while the search field holds text the
 * URL has not been told about yet.
 *
 * The field writes `q` on a debounce. A filter, sort or refine change that
 * cancelled that write and navigated from the URL would lose the edit for
 * good: `q` would not change, so the field would never resync and would keep
 * showing text no result set reflects. Folding the pending value in first
 * makes the change carry the edit instead of discarding it.
 */
export const withPendingQuery = (
  previous: CaseLawIndexSearch,
  pendingQuery: string | null,
): CaseLawIndexSearch => {
  if (pendingQuery === null) {
    return previous;
  }
  return {
    ...previous,
    q: pendingQuery.trim().length > 0 ? pendingQuery : undefined,
  };
};

export const hasActiveCaseLawFilter = (search: CaseLawIndexSearch): boolean =>
  CASE_LAW_FILTER_KEYS.some((key) => search[key] !== undefined);

/**
 * The sort as the URL carries it: absent while it is the default, so the same
 * result set has one canonical address rather than two.
 */
export const decisionSortParam = (
  sort: DecisionSortOrder | undefined,
): DecisionSortOrder | undefined =>
  sort === undefined || sort === DEFAULT_DECISION_SORT ? undefined : sort;

/** The sort a search runs under, whatever the URL left out. */
export const decisionSortOrder = (
  sort: DecisionSortOrder | undefined,
): DecisionSortOrder => sort ?? DEFAULT_DECISION_SORT;

export const createCaseLawIndexPath = ({
  country,
  court,
  lang,
  q,
  sort,
  source,
  type,
  year,
}: CaseLawIndexSearch): `/law/cases${string}` => {
  const params = new URLSearchParams();
  const normalizedYear = validDecisionYear(year);
  if (country) {
    params.set("country", country.toLowerCase());
  }
  if (court) {
    params.set("court", court);
  }
  if (normalizedYear) {
    params.set("year", normalizedYear);
  }
  if (type) {
    params.set("type", type);
  }
  if (source) {
    params.set("source", source);
  }
  if (lang) {
    params.set("lang", lang);
  }
  if (q) {
    params.set("q", q);
  }
  const sortParam = decisionSortParam(sort);
  if (sortParam !== undefined) {
    params.set("sort", sortParam);
  }

  const query = params.toString();
  return query ? `/law/cases?${query}` : "/law/cases";
};
