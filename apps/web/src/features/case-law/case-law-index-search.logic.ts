/**
 * What the case-law results URL holds, and how it is written back out. Pure,
 * because the same rules answer three questions at once: what the loader
 * fetches, what the canonical link says, and what "clear filters" clears.
 *
 * The orders themselves come from the search contract rather than a list of
 * their own: a URL that offered an order the endpoint does not serve, or
 * defaulted to a different one, would be a silent disagreement with the
 * answer. Relevance is first there, and being the default is why it is absent
 * from the URL: a link says what the reader chose, not what they accepted.
 */

import { Result } from "better-result";

import { DEFAULT_SEARCH_SORT } from "@stll/api-contract/search";
import type { SearchSort } from "@stll/api-contract/search";
import { Temporal } from "@stll/time";

/** What the case-law results URL accepts. Every field is single-select. */
export type CaseLawIndexSearch = {
  country?: string | undefined;
  court?: string | undefined;
  /** The start of the decision-date range, `YYYY-MM-DD`. */
  from?: string | undefined;
  lang?: string | undefined;
  q?: string | undefined;
  /**
   * The organization's questions this search draws as columns, in order. Not
   * part of the result set, so the canonical address leaves it out.
   */
  questions?: string[] | undefined;
  sort?: SearchSort | undefined;
  /**
   * Require every word the query carries, as a link beside the results asks
   * for it. Absent while the search may drop a word, which is the default,
   * and dropped again by the next edit of the query it was asked of.
   */
  strict?: StrictSearchValue | undefined;
  /** The end of the decision-date range, inclusive. */
  to?: string | undefined;
  type?: string | undefined;
  /**
   * A whole year, as links made before the range existed spell it. Read, never
   * written: the year list is a quick pick for `from`/`to` now, so one span
   * keeps one address instead of two ways to name the same twelve months.
   */
  year?: string | undefined;
};

/** The single-select facet fields, so clearing cannot miss one added later. */
export const CASE_LAW_FILTER_KEYS = ["court", "lang", "type"] as const;

export type CaseLawFilterKey = (typeof CASE_LAW_FILTER_KEYS)[number];

/**
 * How the URL spells a search that requires every word it carries.
 *
 * A switch a reader lands on from a link beside their results, so it is
 * spelled the way a link spells one rather than the way a caller serialises a
 * boolean; and it is absent while it is off, so the lenient search everyone
 * gets by default keeps one address.
 */
export const STRICT_SEARCH_VALUE = "1";

export type StrictSearchValue = typeof STRICT_SEARCH_VALUE;

/**
 * The value a URL asks strict matching with. A public link may be typed or
 * crawled, so any other spelling is the default search rather than an error.
 */
export const strictSearchValue = (
  value: string | undefined,
): StrictSearchValue | undefined =>
  value === STRICT_SEARCH_VALUE ? STRICT_SEARCH_VALUE : undefined;

/** Whether a URL asks the search to require every word its query carries. */
export const isStrictSearch = (
  strict: StrictSearchValue | undefined,
): boolean => strict !== undefined;

const validDecisionYear = (year: string | undefined): string | undefined =>
  /^\d{4}$/u.test(year ?? "") ? year : undefined;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A calendar date the corpus could hold, or nothing. Shape alone is not
 * enough — `2024-02-30` matches the pattern and is not a date — so the value
 * also has to survive being read as one.
 */
export const validDecisionDate = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined || !ISO_DATE.test(value)) {
    return undefined;
  }
  return Result.try(() => Temporal.PlainDate.from(value)).isOk()
    ? value
    : undefined;
};

/** The span of decision dates a search covers. Either end may be open. */
export type DecisionDateRange = {
  from?: string | undefined;
  to?: string | undefined;
};

/** The range a whole year means, both ends inclusive. */
export const yearDateRange = (year: string): { from: string; to: string } => ({
  from: `${year}-01-01`,
  to: `${year}-12-31`,
});

/**
 * The year a range covers exactly, or nothing when it covers part of one or
 * spans several. What decides whether the rail's year list shows a selection.
 */
export const dateRangeYear = (range: DecisionDateRange): string | undefined => {
  const year = validDecisionYear(range.from?.slice(0, 4));
  if (year === undefined) {
    return undefined;
  }
  const whole = yearDateRange(year);
  return range.from === whole.from && range.to === whole.to ? year : undefined;
};

/**
 * The range a URL asks for. `from`/`to` are what the page writes; a bare
 * `year` is an older link, and it resolves to that year's whole span rather
 * than being dropped.
 */
export const decisionDateRange = ({
  from,
  to,
  year,
}: CaseLawIndexSearch): DecisionDateRange => {
  const start = validDecisionDate(from);
  const end = validDecisionDate(to);
  if (start !== undefined || end !== undefined) {
    return {
      ...(start === undefined ? {} : { from: start }),
      ...(end === undefined ? {} : { to: end }),
    };
  }
  const legacyYear = validDecisionYear(year);
  return legacyYear === undefined ? {} : yearDateRange(legacyYear);
};

const hasDecisionDateRange = (search: CaseLawIndexSearch): boolean => {
  const range = decisionDateRange(search);
  return range.from !== undefined || range.to !== undefined;
};

/** Every filter unset, for a country switch and for "clear filters". */
export const clearedCaseLawFilters = (): Record<CaseLawFilterKey, undefined> &
  Record<"from" | "to" | "year", undefined> => ({
  court: undefined,
  from: undefined,
  lang: undefined,
  to: undefined,
  type: undefined,
  year: undefined,
});

/**
 * The URL a query edit lands on, with `strict` and `questions` dropped.
 *
 * Requiring every word is asked of one query, by a link beside that query's
 * results, and nothing on screen gives it back once it is on. Carried into the
 * next query it would silently require every word of text the reader never
 * asked that of, and the question-shaped searches the widening exists for
 * would answer nothing. The question columns were picked for one topic too: a
 * new query is a new search and starts without them, while a filter, sort,
 * page or strict change narrows the same topic and keeps them. So the drop
 * belongs to the transition rather than to each caller: no place that writes
 * `q` can forget it.
 */
export const withQuery = (
  previous: CaseLawIndexSearch,
  query: string,
): CaseLawIndexSearch => {
  const q = query.trim().length > 0 ? query : undefined;
  if (q === previous.q) {
    return previous;
  }
  return { ...previous, q, strict: undefined, questions: undefined };
};

/**
 * The URL a navigation should start from while the search field holds text the
 * URL has not been told about yet.
 *
 * The field writes `q` on a debounce. A filter or sort change that
 * cancelled that write and navigated from the URL would lose the edit for
 * good: `q` would not change, so the field would never resync and would keep
 * showing text no result set reflects. Folding the pending value in first
 * makes the change carry the edit instead of discarding it.
 */
export const withPendingQuery = (
  previous: CaseLawIndexSearch,
  pendingQuery: string | null,
): CaseLawIndexSearch =>
  pendingQuery === null ? previous : withQuery(previous, pendingQuery);

/**
 * How many filters are on. The date span counts as one whichever ends it
 * names, because that is the one chip it becomes and the one row it occupies
 * in the popover.
 */
export const activeCaseLawFilterCount = (search: CaseLawIndexSearch): number =>
  CASE_LAW_FILTER_KEYS.filter((key) => search[key] !== undefined).length +
  (hasDecisionDateRange(search) ? 1 : 0);

export const hasActiveCaseLawFilter = (search: CaseLawIndexSearch): boolean =>
  activeCaseLawFilterCount(search) > 0;

/**
 * The sort as the URL carries it: absent while it is the default, so the same
 * result set has one canonical address rather than two.
 */
export const decisionSortParam = (
  sort: SearchSort | undefined,
): SearchSort | undefined =>
  sort === undefined || sort === DEFAULT_SEARCH_SORT ? undefined : sort;

/** The sort a search runs under, whatever the URL left out. */
export const decisionSortOrder = (sort: SearchSort | undefined): SearchSort =>
  sort ?? DEFAULT_SEARCH_SORT;

export const createCaseLawIndexPath = (
  search: CaseLawIndexSearch,
): `/law/cases${string}` => {
  const { country, court, lang, q, sort, strict, type } = search;
  const params = new URLSearchParams();
  const range = decisionDateRange(search);
  if (country) {
    params.set("country", country.toLowerCase());
  }
  if (court) {
    params.set("court", court);
  }
  // Canonically a range, whichever way the request spelled it: an older
  // `?year=` link and its `from`/`to` equivalent are one page, not two.
  if (range.from !== undefined) {
    params.set("from", range.from);
  }
  if (range.to !== undefined) {
    params.set("to", range.to);
  }
  if (type) {
    params.set("type", type);
  }
  if (lang) {
    params.set("lang", lang);
  }
  if (q) {
    params.set("q", q);
  }
  // A strict search requires words the same query answered without, so it is
  // a different result set and its address says so.
  if (isStrictSearch(strict)) {
    params.set("strict", STRICT_SEARCH_VALUE);
  }
  const sortParam = decisionSortParam(sort);
  if (sortParam !== undefined) {
    params.set("sort", sortParam);
  }

  const query = params.toString();
  return query ? `/law/cases?${query}` : "/law/cases";
};
