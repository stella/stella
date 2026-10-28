import { useRef, useState } from "react";

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { namedDecisionsOf } from "@stll/api-contract/decision-query-intent";
import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import {
  type DecisionSort,
  SEARCH_TOTAL_NOT_COUNTED,
} from "@stll/api-contract/search";
import { Temporal } from "@stll/time";

import { PublicLawPager } from "@/components/public-law-table/public-law-pager";
import { publicLawNumberedPagerModel } from "@/components/public-law-table/public-law-pagination.logic";
import {
  publicLawRowsPhase,
  publicLawSearchOutage,
  queryAnsweredByRows,
  rowsAnswerRequestedSearch,
} from "@/components/public-law-table/public-law-results-state.logic";
import type { PublicLawRouteState } from "@/components/public-law-table/public-law-results-state.logic";
import {
  PublicLawFilterChips,
  PublicLawResultsToolbar,
} from "@/components/public-law-table/public-law-results-toolbar";
import type { PublicLawFilterChip } from "@/components/public-law-table/public-law-results-toolbar";
import {
  publicLawPageSearchValue,
  publicLawPageSize,
  publicLawPageSizeSearchValue,
} from "@/components/public-law-table/public-law-route-pagination.logic";
import type { PublicLawPageSize } from "@/components/public-law-table/public-law-route-pagination.logic";
import { usePublicLawPageArrival } from "@/components/public-law-table/use-public-law-page-arrival";
import { TableFindBar } from "@/components/workspaces/table/table-find-bar";
import { shouldAutoRewrite } from "@/features/case-law/case-law-empty-results.logic";
import {
  activeCaseLawFilterCount,
  CASE_LAW_FILTER_KEYS,
  clearedCaseLawFilters,
  decisionDateRange,
  isStrictSearch,
  STRICT_SEARCH_VALUE,
  validDecisionDate,
  withAutoRewrite,
  withOriginalWords,
  withPendingQuery,
  withQuery,
} from "@/features/case-law/case-law-index-search.logic";
import type {
  CaseLawFilterKey,
  DecisionDateRange,
} from "@/features/case-law/case-law-index-search.logic";
import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import {
  caseLawDeepestPage,
  caseLawPageNumber,
  caseLawPageRest,
} from "@/features/case-law/case-law-pages.logic";
import {
  CaseLawAutoRewrite,
  CaseLawNoResults,
  RewrittenSearchLine,
} from "@/features/case-law/components/case-law-no-results";
import { CaseLawResultsSummary } from "@/features/case-law/components/case-law-results-summary";
import {
  CaseLawSearch,
  useCaseLawAskScope,
} from "@/features/case-law/components/case-law-search";
import { useDecisionColumnGroups } from "@/features/case-law/components/decision-column-groups";
import { DecisionFilterPopover } from "@/features/case-law/components/decision-filter-popover";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import { DecisionTable } from "@/features/case-law/components/decision-table";
import type { Decision } from "@/features/case-law/components/decision-table";
import {
  DecisionExcerptControl,
  DecisionSortControl,
} from "@/features/case-law/components/decision-toolbar-controls";
import { SearchWidenedLine } from "@/features/case-law/components/search-widened-line";
import { useDecisionColumnPreferences } from "@/features/case-law/decision-column-preferences";
import { decisionReferenceColumnKind } from "@/features/case-law/decision-columns.logic";
import {
  decisionFilterFacets,
  useDecisionBrowseFacets,
} from "@/features/case-law/decision-filter-facets";
import type { DecisionFilterFacets } from "@/features/case-law/decision-filter-facets.logic";
import {
  decisionDateOrder,
  decisionOrder,
} from "@/features/case-law/decision-order.logic";
import { useOpenDecisionInspector } from "@/features/case-law/decision-row-host";
import {
  createDecisionFiltersFromSearch,
  openDecisionMatch,
  readDecisionIntent,
} from "@/features/case-law/open-decision-match";
import {
  decisionsPageOptions,
  usePrefetchedDecisionPage,
} from "@/features/case-law/queries/decisions";
import type { CaseLawBrowseFacets } from "@/features/case-law/queries/decisions";
import {
  QuestionColumnControls,
  useQuestionColumns,
} from "@/features/case-law/research/question-columns-controller";
import { caseLawWarningSurfaces } from "@/features/case-law/search-warnings.logic";
import { useCaseLawRefine } from "@/features/case-law/use-case-law-refine";
import { useDecisionFind } from "@/features/case-law/use-decision-find";
import { useExpandedDecisionFilters } from "@/features/case-law/use-expanded-decision-filters";
import { useFormatter } from "@/i18n/formatting-context";
import { getMessageLocale } from "@/i18n/i18n-store";
import { useMessageLocale } from "@/i18n/message-locale";
import type { TranslationKey } from "@/i18n/types";
import {
  searchTiming,
  useSearchResultsTiming,
} from "@/lib/analytics/search-timing";
import { resolveCaseLawRouteCountry } from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { detachedUserAction } from "@/lib/errors/user-toast";
import { queryView, queryViewError } from "@/lib/query-view.logic";
import {
  PublicLawListFailure,
  PublicLawResultsBoundary,
} from "@/routes/law/-components/public-law-list-failure";

import type { CaseLawIndexSearch } from "./-case-law-search-schema";
import { Route } from "./index";

/** Stable empties, so an unchanged page does not hand the table new arrays. */
const EMPTY_SELECTION: readonly string[] = [];
const NO_SHOWN_QUESTIONS: readonly string[] = [];
const EMPTY_DECISIONS: readonly Decision[] = [];
const NO_BROWSE_FACETS: CaseLawBrowseFacets = {
  country: [],
  court: [],
  year: [],
};

/** Which facet a chip belongs to, for the label the chip carries. */
const FILTER_KIND_LABEL_KEYS = {
  court: "common.court",
  lang: "common.language",
  sourceId: "common.source",
  type: "common.type",
} as const satisfies Record<CaseLawFilterKey, TranslationKey>;

/**
 * The URL with one facet set or unset. Written out per key rather than by a
 * computed property, so a filter key that is not in the search schema cannot
 * be navigated to.
 */
const withFilter = (
  previous: CaseLawIndexSearch,
  key: CaseLawFilterKey,
  value: string | undefined,
): CaseLawIndexSearch => {
  switch (key) {
    case "court":
      return { ...previous, court: value };
    case "lang":
      return { ...previous, lang: value };
    case "type":
      return { ...previous, type: value };
    case "sourceId":
      return { ...previous, sourceId: value };
    default:
      key satisfies never;
      return panic(`Unhandled case-law filter: ${String(key)}`);
  }
};

/**
 * What a chip shows for a selected value. A language is a code; every other
 * facet's value is already the words the reader picked in the popover.
 */
const chipValue = (
  key: CaseLawFilterKey,
  value: string,
  format: ReturnType<typeof useFormatter>,
): string => {
  switch (key) {
    case "lang":
      return languageLabel(format, value);
    case "court":
    case "sourceId":
    case "type":
      return value;
    default:
      key satisfies never;
      return panic(`Unhandled case-law filter: ${String(key)}`);
  }
};

const formatIsoDate = (
  value: string,
  format: ReturnType<typeof useFormatter>,
): string =>
  format.dateTime(
    Temporal.PlainDate.from(value).toZonedDateTime("UTC").epochMilliseconds,
    { dateStyle: "medium", timeZone: "UTC" },
  );

/**
 * The rows the document describes: what the crawler reads and what the
 * collection markup lists. Empty while a background load has not produced
 * that page yet, which only a reader with JavaScript ever sees.
 */
const pageDecisions = (
  page: { decisions: readonly Decision[] } | undefined,
): readonly Decision[] => page?.decisions ?? EMPTY_DECISIONS;

/** Times a search until its own page of results, not a held one, is drawn. */
const useCaseLawResultsTiming = ({
  query,
  page,
  isPlaceholderData,
}: {
  query: string | undefined;
  page: { decisions: readonly Decision[] } | undefined;
  isPlaceholderData: boolean;
}) => {
  useSearchResultsTiming(
    "case-law",
    query ?? "",
    page !== undefined && !isPlaceholderData,
  );
};

type PublicCaseLawIndexProps = {
  /** Whether the router has this page's rows yet. */
  routeState: PublicLawRouteState;
};

export const PublicCaseLawIndexPending = () => (
  <PublicCaseLawIndex routeState="pending" />
);

export function PublicCaseLawIndex({
  routeState = "loaded",
}: Partial<PublicCaseLawIndexProps>) {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const uiLocale = useMessageLocale();
  const search = Route.useSearch({
    select: ({
      country,
      court,
      from,
      lang,
      page,
      pageSize,
      q,
      sort,
      sourceId,
      strict,
      to,
      type,
      year,
    }) => ({
      country,
      court,
      from,
      lang,
      page,
      pageSize,
      q,
      sort,
      sourceId,
      strict,
      to,
      type,
      year,
    }),
  });
  // Read apart from the search: the questions drawn are not part of what the
  // rows, the canonical link or a decision opened from here describe.
  const shownQuestionIds = Route.useSearch({
    select: ({ questions }) => questions ?? NO_SHOWN_QUESTIONS,
  });
  // Also read apart: which words a rewrite replaced does not change the rows.
  const rewriteState = Route.useSearch({
    select: ({ rewrite, rewrittenFrom }) => ({ rewrite, rewrittenFrom }),
  });
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();

  // The resolution `beforeLoad` performs, not a reading of the canonical URL
  // it writes: a pending render can precede that redirect, and a page drawn
  // for the locale's jurisdiction is the page the redirect is on its way to.
  // A loaded page always carries the country, so this reads it back.
  const scope =
    resolveCaseLawRouteCountry({
      country: search.country,
      locale: getMessageLocale(),
    }) ?? panic("The case-law route rendered without a launch-ready country.");
  const countryParam = toCaseLawCountryParam(scope);
  const scopedSearch = { ...search, country: countryParam };
  const { page: _page, pageSize: _pageSize, ...resultSetSearch } = scopedSearch;
  const intent = readDecisionIntent(search.q, { jurisdiction: scope });
  const { layout, setLayout } = useDecisionColumnPreferences(countryParam);
  const typedFilters = createDecisionFiltersFromSearch(scopedSearch, {
    excerpt: layout.excerpt,
  });
  const filters = useExpandedDecisionFilters(typedFilters, intent);

  const [queryInput, setQueryInput] = useState(search.q ?? "");
  // What the field last asked the URL to hold. A navigation that lands on
  // this value is the field's own write coming back, not somebody else's.
  const [requestedQuery, setRequestedQuery] = useState(search.q ?? "");
  const writeQuery = useDebouncedCallback((value: string) => {
    searchTiming.requested("case-law", value);
    detached(
      navigate({
        replace: true,
        search: (previous) => withQuery(previous, value),
      }),
      "cases.search-navigate",
    );
  }, 300);
  const handleQueryChange = (value: string) => {
    setQueryInput(value);
    setRequestedQuery(value.trim());
    writeQuery(value);
  };
  // Resync the field when the route query changes underneath it. Adjust state
  // during render (the React-sanctioned pattern) instead of an effect.
  const [syncedQuery, setSyncedQuery] = useState(search.q);
  if (syncedQuery !== search.q) {
    setSyncedQuery(search.q);
    if ((search.q ?? "") !== requestedQuery) {
      setQueryInput(search.q ?? "");
    }
  }

  // The results column — toolbar, chips and grid: what a Cmd/Ctrl+F inside
  // belongs to, so a press with a cell focused opens this table's find.
  const paneRef = useRef<HTMLDivElement>(null);

  const pageSize = publicLawPageSize(search.pageSize);
  const wantedPage = caseLawPageNumber(search.page, pageSize);
  // The first page describes the result set: its count, its facets, what the
  // search required. On the first page it is the page on screen as well, and
  // the two reads are one query.
  const firstPageQuery = useQuery({
    ...decisionsPageOptions({ filters, page: 1, pageSize }),
    // The count and the facets stay drawn while a new search is in flight.
    placeholderData: keepPreviousData,
  });
  const pageQuery = useQuery({
    ...decisionsPageOptions({ filters, page: wantedPage, pageSize }),
    // The rows on screen stay while another page or another search arrives,
    // so a step never blanks the table.
    placeholderData: keepPreviousData,
  });
  const { data: pageData, isPlaceholderData, refetch } = pageQuery;
  const pageView = queryView(pageQuery);
  const error = queryViewError(pageView);
  const firstPageError = queryViewError(queryView(firstPageQuery));
  const isLoading = pageView.type === "pending";
  useCaseLawResultsTiming({
    query: search.q,
    page: pageData,
    isPlaceholderData,
  });
  // The loader warms these after search; background navigations keep the
  // same order without suspending the page on optional filter choices.
  const { data: browseFacets } = useDecisionBrowseFacets({
    country: scope,
    searchFetched: firstPageQuery.isFetched,
    searchFetchStatus: firstPageQuery.fetchStatus,
  });
  // A failed search is this region's failure, not the page's.
  // The loader lets it through for the same reason, so both the first render
  // and a filter applied to a drawn page arrive here.
  const loadedSearch = Route.useMatch({
    select: (match) => match.loaderData?.search,
  });
  const isSearchUnavailable = publicLawSearchOutage({
    hasPages: pageData !== undefined,
    isQueryOutage: error !== undefined || firstPageError !== undefined,
    loaded: loadedSearch,
  });
  // The rows are the only region that waits: either they are not there yet,
  // or they answer the search before this one and say so themselves rather
  // than the page being replaced.
  const rows = publicLawRowsPhase({ isLoading, isPlaceholderData, routeState });
  const isRefreshing = rows === "stale";

  // The search the rows on screen answer, which lags the URL while their
  // replacements are in flight. Held once here and handed to everything that
  // reads a row, so a faded row's marks, its link and the source chip beside
  // it cannot describe three different searches.
  const [shownQuery, setShownQuery] = useState(search.q);
  const rowsQuery = queryAnsweredByRows({
    phase: rows,
    requested: search.q,
    shown: shownQuery,
  });
  if (shownQuery !== rowsQuery) {
    setShownQuery(rowsQuery);
  }

  const firstPage = firstPageQuery.data;
  const searchTotal = firstPage?.total ?? SEARCH_TOTAL_NOT_COUNTED;
  const pager = publicLawNumberedPagerModel({
    deepestPage: caseLawDeepestPage(pageSize),
    page: wantedPage,
    pageSize,
    rest: caseLawPageRest({ page: pageData, rows }),
    total: searchTotal,
  });
  const decisions = pageDecisions(pageData);

  // Next draws the moment it is pressed: the page after this one is fetched
  // as soon as this one is on screen.
  usePrefetchedDecisionPage({
    filters,
    page: rows === "rows" ? pager.nextPage : null,
    pageSize,
  });
  // Keep the pager reachable for another keyboard step after the rows change.
  const requestPage = usePublicLawPageArrival({
    focusOnArrival: "preserve",
    regionRef: paneRef,
    shownPage: rows === "rows" ? pager.currentPage : null,
  });
  // The named decision first, when the entry named one; the decisions of one
  // file, or the same docket at several courts, stay several rows the reader
  // chooses between.
  const exact = namedDecisionsOf(intent, decisions);
  const exactIds = new Set(exact.map((decision) => decision.id));
  const ordered =
    exact.length === 0
      ? decisions
      : [...exact, ...decisions.filter((d) => !exactIds.has(d.id))];

  // What the search said about itself, read off the first page: a warning is
  // about the result set, not about the page of it the reader is looking at.
  // The wire's own English sentences are never drawn; the code picks the keys
  // and the reader's language renders them.
  const warnings = caseLawWarningSurfaces(firstPage?.answered ?? null);
  const facets: DecisionFilterFacets = decisionFilterFacets({
    browse: browseFacets ?? NO_BROWSE_FACETS,
    search: firstPage?.facets ?? null,
  });

  // A pending debounced query write holds text the URL has not seen yet.
  // Letting it land after this navigation would re-apply the old field value
  // to the new filters; cancelling it alone would strand the edit for good,
  // because `search.q` never changes and the field never resyncs. So the
  // pending text is folded in first and the caller's own change applied over
  // it. Returns the navigation so each caller tags it with a literal label.
  //
  // Every such change also drops the page: page 3 of the old result set
  // names nothing in the new one.
  const searchNavigation = async (
    nextSearch: (previous: CaseLawIndexSearch) => CaseLawIndexSearch,
  ) => {
    const pending = writeQuery.isPending() ? queryInput : null;
    writeQuery.cancel();
    await navigate({
      replace: true,
      search: (previous) =>
        nextSearch({ ...withPendingQuery(previous, pending), page: undefined }),
    });
  };

  // Picked rows narrow a run to them; the page they belong to is the only
  // page they mean anything on, so a step forward clears them.
  const openDecision = useOpenDecisionInspector(rowsQuery);
  const [selectedIds, setSelectedIds] =
    useState<readonly string[]>(EMPTY_SELECTION);
  const [selectionPage, setSelectionPage] = useState(pager.currentPage);
  if (selectionPage !== pager.currentPage) {
    setSelectionPage(pager.currentPage);
    setSelectedIds(EMPTY_SELECTION);
  }
  const pageDecisionIds = decisions.map((decision) => decision.id);
  const questions = useQuestionColumns({
    // The results page is where questions are authored, so the columns are
    // read whether or not this particular search returned anything.
    enabled: true,
    onShowPassage: openDecision,
    pageDecisionIds,
    // The search the reader is looking at, so a suggested question targets
    // these decisions rather than court decisions in general.
    search: {
      country: filters.country,
      query: filters.search,
      filters: {
        court: filters.court,
        decisionType: filters.decisionType,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        language: filters.language,
      },
    },
    selectedDecisionIds: selectedIds,
    // The organization owns the questions; this search's URL picks which to
    // draw. A new query drops the pick (see `withQuery`); nothing else here
    // touches it.
    shownQuestionIds,
    onShownQuestionIdsChange: (update) => {
      // Adding or removing a question column is the reader's own press; a
      // navigation that fails says so instead of leaving the table unchanged.
      detachedUserAction(
        navigate({
          replace: true,
          search: (previous) => ({
            ...previous,
            questions: update(previous.questions ?? NO_SHOWN_QUESTIONS),
          }),
        }),
        {
          context: "cases.questions-navigate",
          failureMessage: t("errors.actionFailed"),
        },
      );
    },
  });
  // What the case-number column is called, from the whole page rather than
  // the rows a find leaves, so the header does not change while the reader
  // types.
  const referenceKind = decisionReferenceColumnKind(ordered);
  // Find-in-table over the page on screen, beside the control that narrows the
  // search itself. Kept per jurisdiction, the way the arrangement is.
  const columnGroups = useDecisionColumnGroups({
    questions: questions.surface,
    referenceKind,
  });
  const find = useDecisionFind({
    decisions: ordered,
    layout,
    paneRef,
    questions: questions.surface,
    referenceKind,
    surfaceKey: countryParam,
  });

  const setPageSize = (next: PublicLawPageSize) => {
    detachedUserAction(
      searchNavigation((previous) => ({
        ...previous,
        pageSize: publicLawPageSizeSearchValue(next),
      })),
      {
        context: "cases.page-size-navigate",
        failureMessage: t("errors.actionFailed"),
      },
    );
  };

  // The same search with every word required. It leaves the URL like every
  // other change here — the pending field text folded in, the page dropped —
  // because the words it requires are a different result set.
  const searchEveryWord = () => {
    detachedUserAction(
      searchNavigation((previous) => ({
        ...previous,
        strict: STRICT_SEARCH_VALUE,
      })),
      {
        context: "cases.strict-navigate",
        failureMessage: t("errors.actionFailed"),
      },
    );
  };

  const selectFacet = (key: CaseLawFilterKey, value: string | undefined) => {
    detached(
      searchNavigation((previous) => withFilter(previous, key, value)),
      "cases.filter-navigate",
    );
  };

  // Only `from`/`to` are written; a `year` the reader arrived with is dropped
  // the moment they touch the range, so the two can never disagree.
  const setDateRange = (range: DecisionDateRange) => {
    detached(
      searchNavigation((previous) => ({
        ...previous,
        from: validDecisionDate(range.from),
        to: validDecisionDate(range.to),
        year: undefined,
      })),
      "cases.date-range-navigate",
    );
  };

  const dateRange = decisionDateRange(search);
  const chips: PublicLawFilterChip[] = [];
  // The same three shapes, and the same strings, the workspace view's own
  // date chip uses; built here rather than in a helper taking `t`, because
  // handing the translator through a parameter widens its key union at the
  // boundary and the instantiation cost lands on every build.
  const dateFrom =
    dateRange.from === undefined ? null : formatIsoDate(dateRange.from, format);
  const dateTo =
    dateRange.to === undefined ? null : formatIsoDate(dateRange.to, format);
  let dateRangeLabel: string | null = null;
  if (dateFrom !== null && dateTo !== null) {
    dateRangeLabel = t("workspaces.filters.date.customRange", {
      from: dateFrom,
      to: dateTo,
    });
  } else if (dateFrom !== null) {
    dateRangeLabel = t("workspaces.filters.date.from", { date: dateFrom });
  } else if (dateTo !== null) {
    dateRangeLabel = t("workspaces.filters.date.to", { date: dateTo });
  }
  if (dateRangeLabel !== null) {
    chips.push({
      id: "filter:date",
      kind: t("common.date"),
      onRemove: () => setDateRange({}),
      value: dateRangeLabel,
    });
  }
  for (const key of CASE_LAW_FILTER_KEYS) {
    const value = search[key];
    if (value === undefined) {
      continue;
    }
    chips.push({
      id: `filter:${key}`,
      kind: t(FILTER_KIND_LABEL_KEYS[key]),
      onRemove: () => selectFacet(key, undefined),
      value:
        key === "sourceId"
          ? (facets.source.find((bucket) => bucket.value === value)?.label ??
            value)
          : chipValue(key, value, format),
    });
  }
  // Enter on an identifier opens the decision when exactly one answers to it.
  // Several (the same docket at several courts) stay listed, so the reader
  // picks; nothing is guessed. The field's value is read directly: the
  // debounced URL write may still be pending.
  const openSingleMatch = () => {
    const entry = queryInput.trim();
    if (entry.length === 0) {
      return;
    }
    writeQuery.flush();
    detached(
      openDecisionMatch({
        excerpt: layout.excerpt,
        navigate: routerNavigate,
        queryClient,
        search: { ...scopedSearch, q: entry },
        uiLocale,
      }),
      "cases.open-match",
    );
  };

  // The AI rewrite replaces the entry and runs at once, the way a typed edit
  // would after its debounce: the field shows the words the search required,
  // and the URL, not the field, is what searches.
  const searchRefinedQuery = (refined: string) => {
    setQueryInput(refined);
    setRequestedQuery(refined);
    detached(
      searchNavigation((previous) => withQuery(previous, refined)),
      "cases.refine-navigate",
    );
  };
  const {
    autoRewrite,
    autoRewriteKey,
    onAutoRefine,
    refine,
    searchOriginalWords,
  } = useCaseLawRewriteFlow({
    country: countryParam,
    isTextSearch: intent.type === "text",
    query: queryInput,
    resultCount: decisions.length,
    isFirstPage: pager.currentPage === 1,
    rowsAnswerQuery: rows === "rows",
    search: { ...search, ...rewriteState },
    searchNavigation,
    searchRefinedQuery,
    setQuery: (next) => {
      setQueryInput(next);
      setRequestedQuery(next);
    },
  });
  const askScope = useCaseLawAskScope(countryParam);

  // One resolution of the order for the whole page: the toolbar, the date
  // header and the listing's heading all read it. No order applies to an
  // identifier lookup, which the identity path ranks whatever the URL asks
  // for; offering a choice the answer ignores would also mark the date column
  // as sorted when it is not.
  const order = decisionOrder(intent, search.sort);
  const changeSort = (next: DecisionSort) => {
    detached(
      searchNavigation((previous) => ({ ...previous, sort: next })),
      "cases.sort-navigate",
    );
  };
  const dateOrder = decisionDateOrder({
    order,
    onSortChange: changeSort,
    unavailableReason: t("caseLaw.sort.oldestUnavailable"),
  });

  // The pane below claims the page's height, so on a normal viewport nothing
  // overflows here and the table owns the only scroll. The page scroller stays
  // as the fallback for a viewport too short to hold the table's own minimum:
  // without it the stack would be clipped and the pager unreachable.
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/*
        The breadcrumb already names the screen, so the heading is for the
        document outline and for a screen reader, not for the eye.
      */}
      <h1 className="sr-only">{t("common.caseLaw")}</h1>

      <CaseLawSearch
        country={countryParam}
        maxLength={SEARCH_QUERY_MAX_LENGTH}
        onQueryChange={handleQueryChange}
        onSubmit={openSingleMatch}
        query={queryInput}
        refine={refine}
      />
      {autoRewrite && (
        <CaseLawAutoRewrite key={autoRewriteKey} onAutoRefine={onAutoRefine} />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" ref={paneRef}>
        <PublicLawResultsToolbar
          actions={<QuestionColumnControls controller={questions} />}
          columnGroups={columnGroups}
          controls={
            // A browse listing draws each decision's own headnote, not a
            // matched passage, so there is no excerpt to widen and the control
            // is not offered. `filters.search` is what the search endpoint was
            // actually given, so it answers that exactly.
            filters.search === undefined ? undefined : (
              <DecisionExcerptControl
                excerpt={layout.excerpt}
                onExcerptChange={(excerpt) => setLayout({ ...layout, excerpt })}
              />
            )
          }
          filters={
            <DecisionFilterPopover
              activeFilterCount={activeCaseLawFilterCount(search)}
              dateRange={dateRange}
              facets={facets}
              onDateRangeChange={setDateRange}
              onSelect={selectFacet}
              selection={{
                court: search.court,
                lang: search.lang,
                sourceId: search.sourceId,
                type: search.type,
              }}
            />
          }
          find={<TableFindBar {...find.bar} />}
          layout={layout}
          onLayoutChange={setLayout}
          sort={
            order.type === "identity" ? undefined : (
              <DecisionSortControl onSortChange={changeSort} order={order} />
            )
          }
          summary={
            // The widened-search note sits on the count's line, not on a
            // line of its own: it qualifies the count, and a row between the
            // toolbar and the table pushed every result down for one clause.
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <CaseLawResultsSummary
                exactCount={exact.length}
                isRefreshing={isRefreshing}
                order={order}
                page={pager.currentPage}
                relaxedHitCount={pageData?.relaxedHitCount}
                total={searchTotal}
              />
              {rewriteState.rewrittenFrom === undefined ||
              isSearchUnavailable ? null : (
                <RewrittenSearchLine
                  onSearchOriginal={searchOriginalWords}
                  original={rewriteState.rewrittenFrom}
                  rewritten={search.q ?? ""}
                />
              )}
              {warnings.resultsLine === null || isSearchUnavailable ? null : (
                <SearchWidenedLine
                  line={warnings.resultsLine}
                  onSearchEveryWord={
                    rowsAnswerRequestedSearch(rows) ? searchEveryWord : null
                  }
                />
              )}
            </div>
          }
        />

        <PublicLawFilterChips
          chips={chips}
          onClearAll={() => {
            // Clear the filters, not the query the reader typed into the box:
            // the box is the search, and emptying it is its own gesture.
            detached(
              searchNavigation((previous) => ({
                ...previous,
                ...clearedCaseLawFilters(),
              })),
              "cases.clear-filters",
            );
          }}
        />

        {isSearchUnavailable ? (
          <PublicLawListFailure
            description={t("caseLaw.searchUnavailable.description")}
            error={error ?? firstPageError}
            reset={() => {
              detached(
                Promise.all([refetch(), firstPageQuery.refetch()]),
                "cases.search-retry",
              );
            }}
          />
        ) : (
          <PublicLawResultsBoundary
            searchKey={JSON.stringify(resultSetSearch)}
            resetOn={pageData}
          >
            <DecisionTable
              dateOrder={dateOrder}
              decisions={find.rows}
              emptyState={
                intent.type === "text" ? (
                  <CaseLawNoResults
                    askScope={askScope}
                    onSearchEveryWord={
                      warnings.resultsLine !== null &&
                      rowsAnswerRequestedSearch(rows)
                        ? searchEveryWord
                        : null
                    }
                    query={search.q ?? ""}
                    reason={warnings.emptyState}
                    refine={refine}
                  />
                ) : undefined
              }
              expectedRowCount={pageSize}
              findHighlight={find.highlight}
              firstRowNumber={(pager.currentPage - 1) * pageSize + 1}
              isLoading={rows === "skeleton"}
              isRefreshing={isRefreshing}
              layout={layout}
              onLayoutChange={setLayout}
              onSelectedIdsChange={setSelectedIds}
              query={rowsQuery}
              questions={questions.surface}
              referenceKind={referenceKind}
              selectedIds={selectedIds}
            />
            <PublicLawPager
              navigation={{ type: "numbered", model: pager }}
              onPageRequest={requestPage}
              onPageSizeChange={setPageSize}
              pageLink={({ label, page }) => (
                <Link
                  aria-label={label}
                  search={(previous) => ({
                    ...previous,
                    page: publicLawPageSearchValue(page),
                  })}
                  to="/law/cases"
                />
              )}
              pageSize={pageSize}
            />
          </PublicLawResultsBoundary>
        )}
      </div>
    </main>
  );
}

type CaseLawRewriteFlowOptions = {
  country: string;
  isTextSearch: boolean;
  /** What the box holds now. */
  query: string;
  resultCount: number;
  isFirstPage: boolean;
  rowsAnswerQuery: boolean;
  search: CaseLawIndexSearch;
  searchNavigation: (
    nextSearch: (previous: CaseLawIndexSearch) => CaseLawIndexSearch,
  ) => Promise<void>;
  searchRefinedQuery: (refined: string) => void;
  /** Put words in the box and make them the search the rows wait on. */
  setQuery: (query: string) => void;
};

/**
 * The AI rewrite as this page runs it: from the wand, from the empty results,
 * or by itself once when a question found nothing; and the way back to the
 * reader's own words, which the page then leaves alone.
 */
const useCaseLawRewriteFlow = ({
  country,
  isTextSearch,
  query,
  resultCount,
  isFirstPage,
  rowsAnswerQuery,
  search,
  searchNavigation,
  searchRefinedQuery,
  setQuery,
}: CaseLawRewriteFlowOptions) => {
  const refine = useCaseLawRefine({
    country,
    query,
    strict: isStrictSearch(search.strict),
    onRefined: searchRefinedQuery,
    onAutoRefined: (refined, original) => {
      setQuery(refined);
      detached(
        searchNavigation((previous) =>
          withAutoRewrite(previous, refined, original),
        ),
        "cases.auto-refine-navigate",
      );
    },
  });
  const searchOriginalWords = () => {
    const original = search.rewrittenFrom;
    if (original === undefined) {
      return;
    }
    setQuery(original);
    // A pending query write drops `rewrittenFrom`; restore the words this
    // click saw so the original search still wins.
    detached(
      searchNavigation((previous) =>
        withOriginalWords({ ...previous, rewrittenFrom: original }),
      ),
      "cases.original-words-navigate",
    );
  };
  // Held here, not in the component that runs the rewrite: that unmounts
  // whenever the box stops matching the search, and must not try again when
  // it mounts back for the same search.
  const searchKey = `${country}:${search.q ?? ""}`;
  const [attemptedSearch, setAttemptedSearch] = useState<string | null>(null);
  const onAutoRefine = () => {
    setAttemptedSearch(searchKey);
    refine.onAutoRefine();
  };
  const autoRewrite = shouldAutoRewrite({
    isTextSearch,
    query: search.q ?? "",
    typedQuery: query,
    resultCount,
    isFirstPage,
    rowsAnswerQuery,
    rewrittenFrom: search.rewrittenFrom,
    rewriteOff: search.rewrite === "off",
    alreadyAttempted: attemptedSearch === searchKey,
    strict: isStrictSearch(search.strict),
  });
  return {
    autoRewrite,
    autoRewriteKey: searchKey,
    onAutoRefine,
    refine,
    searchOriginalWords,
  };
};
