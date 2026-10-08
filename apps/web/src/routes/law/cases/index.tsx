import { useRef, useState } from "react";

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  notFound,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { panic, Result, UnhandledException } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import {
  type DecisionQueryIntent,
  namedDecisionsOf,
} from "@stll/api-contract/decision-query-intent";
import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import {
  DEFAULT_SEARCH_EXCERPT,
  SEARCH_SORTS,
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
  type SearchSort,
  type SearchTotal,
} from "@stll/api-contract/search";
import { Temporal } from "@stll/time";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { RefreshCwIcon, SearchXIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { PublicLawPager } from "@/components/public-law-table/public-law-pager";
import {
  publicLawNumberedPagerModel,
  publicLawPageSearchSchemaUpTo,
  publicLawPageSearchValue,
  publicLawPageSize,
  publicLawPageSizeSearchSchema,
  publicLawPageSizeSearchValue,
} from "@/components/public-law-table/public-law-pagination.logic";
import type { PublicLawPageSize } from "@/components/public-law-table/public-law-pagination.logic";
import {
  PUBLIC_LAW_SEARCH_STATE,
  publicLawRowsPhase,
  publicLawLoadMode,
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
import { usePublicLawPageArrival } from "@/components/public-law-table/use-public-law-page-arrival";
import { TableFindBar } from "@/components/workspaces/table/table-find-bar";
import {
  activeCaseLawFilterCount,
  CASE_LAW_FILTER_KEYS,
  clearedCaseLawFilters,
  createCaseLawIndexPath,
  decisionDateRange,
  decisionSortOrder,
  hasActiveCaseLawFilter,
  STRICT_SEARCH_VALUE,
  strictSearchValue,
  validDecisionDate,
  withPendingQuery,
  withQuery,
} from "@/features/case-law/case-law-index-search.logic";
import type {
  CaseLawFilterKey,
  DecisionDateRange,
} from "@/features/case-law/case-law-index-search.logic";
import {
  caseLawCountryScope,
  publicCaseLawCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import {
  CASE_LAW_MAX_PAGE,
  caseLawDeepestPage,
  caseLawLandingPage,
  caseLawPageNumber,
  caseLawPageRest,
} from "@/features/case-law/case-law-pages.logic";
import { CaseLawSearch } from "@/features/case-law/components/case-law-search";
import { useDecisionColumnGroups } from "@/features/case-law/components/decision-column-groups";
import { DecisionFilterPopover } from "@/features/case-law/components/decision-filter-popover";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import { DecisionTable } from "@/features/case-law/components/decision-table";
import type { Decision } from "@/features/case-law/components/decision-table";
import {
  DecisionExcerptControl,
  DecisionSortControl,
} from "@/features/case-law/components/decision-toolbar-controls";
import { useDecisionColumnPreferences } from "@/features/case-law/decision-column-preferences";
import { decisionReferenceColumnKind } from "@/features/case-law/decision-columns.logic";
import {
  decisionFilterFacets,
  prefetchDecisionFacetsAfterSearch,
  useDecisionBrowseFacets,
} from "@/features/case-law/decision-filter-facets";
import type { DecisionFilterFacets } from "@/features/case-law/decision-filter-facets.logic";
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
import { searchQuestionsParam } from "@/features/case-law/research/search-questions.logic";
import { caseLawWarningSurfaces } from "@/features/case-law/search-warnings.logic";
import type {
  CaseLawEmptyState,
  CaseLawResultsLine,
} from "@/features/case-law/search-warnings.logic";
import { useDecisionFind } from "@/features/case-law/use-decision-find";
import { useExpandedDecisionFilters } from "@/features/case-law/use-expanded-decision-filters";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { getMessageLocale, getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import { resolveCaseLawRouteCountry } from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { readQueryResult } from "@/lib/errors/query-result";
import { detachedUserAction } from "@/lib/errors/user-toast";
import { pageTitle } from "@/lib/page-title";
import {
  isSearchUnavailableError,
  SEARCH_UNAVAILABLE_STATUS,
} from "@/lib/public-law-api";
import {
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureRouteQueryData } from "@/lib/react-query";
import { optionalUuidSearchSchema } from "@/lib/schema";
import { optionalLawSearchQuerySchema } from "@/routes/law/-search-query.logic";
import { ssrStatusHeaders } from "@/ssr-response-status";

/** Stable empties, so an unchanged page does not hand the table new arrays. */
const EMPTY_SELECTION: readonly string[] = [];
const NO_SHOWN_QUESTIONS: readonly string[] = [];
const EMPTY_DECISIONS: readonly Decision[] = [];
const NO_BROWSE_FACETS: CaseLawBrowseFacets = {
  country: [],
  court: [],
  year: [],
};

const optionalBrowseStringSchema = (maxLength: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(maxLength),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  );

/**
 * A calendar date, dropped rather than refused when it is not one: a public
 * URL may be typed or crawled, and a bad date is a page without that bound,
 * not an error screen.
 */
const optionalDateSchema = v.fallback(
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.transform((value) => validDecisionDate(value)),
    ),
  ),
  undefined,
);

/**
 * Whether the search requires every word its query carries. Read leniently
 * like the rest: any spelling but the one the link writes is the default
 * search, which is what a hand-typed or crawled URL gets.
 */
const optionalStrictSchema = v.fallback(
  v.optional(
    v.pipe(
      v.string(),
      v.transform((value) => strictSearchValue(value)),
    ),
  ),
  undefined,
);

const searchSchema = v.object({
  country: optionalBrowseStringSchema(3),
  court: optionalBrowseStringSchema(512),
  from: optionalDateSchema,
  lang: optionalBrowseStringSchema(16),
  // Read up to the deepest page any size reaches; `beforeLoad` applies the
  // size's own bound.
  page: publicLawPageSearchSchemaUpTo(CASE_LAW_MAX_PAGE),
  pageSize: publicLawPageSizeSearchSchema,
  q: optionalLawSearchQuerySchema,
  // The organization's questions this search draws, in order. Read leniently
  // like the rest; an id the reader's organization does not hold is not drawn.
  questions: v.fallback(
    v.optional(
      v.pipe(
        v.array(v.string()),
        v.transform((columnIds) => searchQuestionsParam(columnIds)),
      ),
    ),
    undefined,
  ),
  // A link is public and may be edited by hand or by a crawler; an order this
  // build does not know is not an error page, it is the default order.
  sort: v.fallback(v.optional(v.picklist(SEARCH_SORTS)), undefined),
  sourceId: optionalUuidSearchSchema,
  strict: optionalStrictSchema,
  to: optionalDateSchema,
  type: optionalBrowseStringSchema(128),
  // Accepted, never written: links made before the range existed still work,
  // and `decisionDateRange` resolves them to that year's whole span.
  year: optionalBrowseStringSchema(4),
});

type CaseLawIndexSearch = v.InferOutput<typeof searchSchema>;

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
 * The search helpers, fetched when a route hook first needs them rather than
 * with the route: the docket grammars they parse a query with then stay out
 * of the chunks every page preloads. The page component imports them
 * directly, since it already loads on demand.
 */
const loadDecisionSearch = async () =>
  await import("@/features/case-law/open-decision-match");

const createCaseLawIndexDescription = (search: CaseLawIndexSearch): string => {
  const t = getTranslator();
  const range = decisionDateRange(search);
  const scope = [
    search.court,
    caseLawCountryScope(search.country),
    range.from,
    range.to,
  ]
    .filter(Boolean)
    .join(", ");
  if (scope) {
    return t("caseLaw.seo.scopedDescription", { scope });
  }

  return t("caseLaw.seo.description");
};

/**
 * A results read, answering null when the search backend could not be
 * reached. Every other failure is propagated untouched, so the route's error
 * boundary still owns it and still reads the status off the original error;
 * `Result#unwrap` would hand it on wrapped in a `Panic` instead.
 */
const resultsOrOutage = async <TRead,>(
  read: Promise<TRead>,
): Promise<TRead | null> => {
  const result = await Result.tryPromise({
    try: async () => await read,
    // A rejection that is not an `Error` carries no status to classify and no
    // stack to report, so it is named before it travels any further.
    catch: (cause): Error =>
      cause instanceof Error ? cause : new UnhandledException({ cause }),
  });
  return Result.isError(result) && isSearchUnavailableError(result.error)
    ? null
    : readQueryResult(result);
};

/**
 * The rows the document describes: what the crawler reads and what the
 * collection markup lists. Empty while a background load has not produced
 * that page yet, which only a reader with JavaScript ever sees.
 */
const pageDecisions = (
  page: { decisions: readonly Decision[] } | undefined,
): readonly Decision[] => page?.decisions ?? EMPTY_DECISIONS;

export const Route = createFileRoute("/law/cases/")({
  validateSearch: searchSchema,
  // Which questions are drawn does not change the rows, so picking one must
  // not send the loader after them again.
  loaderDeps: ({ search: { questions, ...search } }) => search,
  // This is a results screen, not an entry screen: with nothing to show
  // results for, the reader belongs on the home. A first visit also starts in
  // the jurisdiction the UI language points at, and the URL says so, so the
  // page and its links agree on the scope. A locale without a matching public
  // country uses the generated list's first entry. Both are server-side
  // redirects because this is a public SSR path: the throw becomes a real
  // HTTP redirect for crawlers and no-JS clients. The blank-page race that
  // no-beforeload-redirect guards against is specific to the client-only
  // _protected subtree.
  beforeLoad: async ({ context: { queryClient }, search }) => {
    const country = resolveCaseLawRouteCountry({
      country: search.country,
      locale: getMessageLocale(),
    });
    if (country === null) {
      notFound({ throw: true });
      return;
    }
    const countryParam = toCaseLawCountryParam(country);

    // Only a request that names nothing goes home; a jurisdiction alone is
    // the browse slice the home's country links and the crawler follow.
    if (
      search.q === undefined &&
      search.country === undefined &&
      !hasActiveCaseLawFilter(search)
    ) {
      throw redirect({
        to: "/law",
        search: { country: countryParam },
        replace: true,
      });
    }

    // What this URL can actually serve: the jurisdiction spelled the way the
    // links spell it, and a page the results reach. Any page up to the
    // deepest is one request away, so a reload, a shared URL, a new tab and a
    // crawler land on the page they name: a page past the deepest is the
    // deepest, and a page past the results' end is the last that holds rows.
    // One redirect for all of it, so the reader is corrected once.
    const pageSize = publicLawPageSize(search.pageSize);
    const wanted = caseLawPageNumber(search.page, pageSize);
    let reached = wanted;
    const { createDecisionFiltersFromSearch: filtersFromSearch } =
      await loadDecisionSearch();
    const filters = filtersFromSearch(
      { ...search, country: countryParam },
      // The excerpt length lives in the reader's browser, which the router
      // cannot reach here. Priming the default keeps this read on the entry
      // the reader's first page will read when they never changed it.
      { excerpt: DEFAULT_SEARCH_EXCERPT },
    );
    const firstPageOptions = decisionsPageOptions({
      filters,
      page: 1,
      pageSize,
    });
    // Every navigation to a page past the first checks that the page holds
    // rows, a pager step as much as a cold arrival: the count may be an
    // estimate that overstates the results, and an empty table is not a page.
    // A page the pager prefetched is a cache read here; any other is the one
    // request the page needs anyway, and the loader and the rows read it from
    // the cache. The first page comes along for the count the walk back needs.
    if (wanted > 1) {
      const readPage = async (page: number) =>
        await resultsOrOutage(
          ensureRouteQueryData(
            queryClient,
            decisionsPageOptions({ filters, page, pageSize }),
          ),
        );
      const [firstPage] = await Promise.all([
        resultsOrOutage(ensureRouteQueryData(queryClient, firstPageOptions)),
        readPage(wanted),
      ]);
      // An outage proves nothing about which pages exist, so the URL keeps
      // the page the reader linked to: the results region says the search is
      // down, and correcting them to page one would lose the link to a
      // failure that passes.
      if (firstPage !== null) {
        reached = await caseLawLandingPage({
          pageSize,
          rowsOn: async (page) =>
            (await readPage(page))?.decisions.length ?? null,
          total: firstPage.total,
          wanted,
        });
      }
    }
    const page = publicLawPageSearchValue(reached);
    if (search.country !== countryParam || search.page !== page) {
      throw redirect({
        to: "/law/cases",
        search: { ...search, country: countryParam, page },
        replace: true,
      });
    }
  },
  loader: async ({ cause, context: { queryClient }, deps }) => {
    const scope =
      publicCaseLawCountryFromParam(deps.country) ??
      panic("The case-law route loaded without a launch-ready country.");
    const { createDecisionFiltersFromSearch: filtersFromSearch } =
      await loadDecisionSearch();
    // The default again: a loader has no browser storage to read the reader's
    // length from, and a reader who never changed it lands on the entry this
    // primes.
    const filters = filtersFromSearch(deps, {
      excerpt: DEFAULT_SEARCH_EXCERPT,
    });
    const pageSize = publicLawPageSize(deps.pageSize);
    const firstPageOptions = decisionsPageOptions({
      filters,
      page: 1,
      pageSize,
    });
    const shownPageOptions = decisionsPageOptions({
      filters,
      page: caseLawPageNumber(deps.page, pageSize),
      pageSize,
    });
    const mode = publicLawLoadMode({
      cause,
      hasCachedPages:
        queryClient.getQueryData(firstPageOptions.queryKey) !== undefined,
    });

    // A filter, a sort or a page step on a page that is already drawn: the
    // toolbar, the headers and the pager are all still correct, so awaiting
    // the new rows here would replace a live page with a skeleton for
    // nothing. The components hold the previous rows and swap them in place.
    if (mode === "background") {
      return {
        decisions: pageDecisions(
          queryClient.getQueryData(shownPageOptions.queryKey),
        ),
        search: PUBLIC_LAW_SEARCH_STATE.answered,
      };
    }

    // The first page describes the result set (its count, its facets) and
    // the page the URL names holds the rows; both are read together, and a
    // deep arrival finds them in the cache `beforeLoad` filled.
    const decisionPages = await prefetchDecisionFacetsAfterSearch({
      country: scope,
      queryClient,
      search: resultsOrOutage(
        Promise.all([
          ensureRouteQueryData(queryClient, firstPageOptions),
          ensureRouteQueryData(queryClient, shownPageOptions),
        ]),
      ),
    });

    // The rows are one region of this page, so a search backend that cannot be
    // reached is that region's failure and not the route's: the box and the
    // filters are the URL's own and stay usable. Every other failure is still
    // the error boundary's.
    if (decisionPages === null) {
      return { decisions: [], search: PUBLIC_LAW_SEARCH_STATE.unavailable };
    }

    const [, shownPage] = decisionPages;
    return {
      decisions: pageDecisions(shownPage),
      search: PUBLIC_LAW_SEARCH_STATE.answered,
    };
  },
  // The document is drawn, but it lists nothing and the results it stands for
  // are still out there. 503 tells a crawler to come back for them instead of
  // recording this page as empty.
  headers: ({ loaderData }) =>
    loaderData?.search === PUBLIC_LAW_SEARCH_STATE.unavailable
      ? ssrStatusHeaders(SEARCH_UNAVAILABLE_STATUS)
      : undefined,
  head: ({ loaderData, match }) => {
    const t = getTranslator();
    const search = match.search;
    const title = pageTitle("common.caseLaw");
    const description = createCaseLawIndexDescription(search);
    const path = createCaseLawIndexPath(search);

    return createPublicLawHead({
      description,
      jsonLd: createLegalCollectionJsonLd({
        t,
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        kind: "caseLaw",
        items: loaderData
          ? loaderData.decisions.map((decision) => ({
              name: decision.caseNumber,
              url: createPublicLawCanonicalUrl(
                createCaseLawDecisionPath(
                  createCaseLawDecisionRouteParams({
                    caseNumber: decision.caseNumber,
                    country: decision.country,
                    court: decision.court,
                    decisionId: decision.id,
                    language: decision.language,
                    languageAlternates: decision.languageAlternates,
                    slug: decision.slug,
                  }),
                ),
              ),
            }))
          : [],
        name: title,
      }),
      path,
      title,
      type: "website",
    });
  },
  // One page, two states. Only a cold arrival renders the pending one — a
  // filter, a sort or a page step keeps the page it is already on — and what
  // waits there is the grid alone: the box, the toolbar, the chips and the
  // pager are the URL's own and are already correct.
  component: () => <PublicCaseLawIndex routeState="loaded" />,
  pendingComponent: () => <PublicCaseLawIndex routeState="pending" />,
});

type PublicCaseLawIndexProps = {
  /** Whether the router has this page's rows yet. */
  routeState: PublicLawRouteState;
};

function PublicCaseLawIndex({ routeState }: PublicCaseLawIndexProps) {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const uiLocale = useLocale();
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
  const intent = readDecisionIntent(search.q, { jurisdiction: scope });
  const { layout, setLayout } = useDecisionColumnPreferences(countryParam);
  const typedFilters = createDecisionFiltersFromSearch(search, {
    excerpt: layout.excerpt,
  });
  const filters = useExpandedDecisionFilters(typedFilters, intent);

  const [queryInput, setQueryInput] = useState(search.q ?? "");
  // What the field last asked the URL to hold. A navigation that lands on
  // this value is the field's own write coming back, not somebody else's.
  const [requestedQuery, setRequestedQuery] = useState(search.q ?? "");
  const writeQuery = useDebouncedCallback((value: string) => {
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
  const {
    data: pageData,
    error,
    isLoading,
    isPlaceholderData,
    refetch,
  } = useQuery({
    ...decisionsPageOptions({ filters, page: wantedPage, pageSize }),
    // The rows on screen stay while another page or another search arrives,
    // so a step never blanks the table.
    placeholderData: keepPreviousData,
  });
  // The loader warms these after search; background navigations keep the
  // same order without suspending the page on optional filter choices.
  const { data: browseFacets } = useDecisionBrowseFacets({
    country: scope,
    searchFetched: firstPageQuery.isFetched,
    searchFetchStatus: firstPageQuery.fetchStatus,
  });
  // A backend that cannot be reached is this region's failure, not the page's.
  // The loader lets it through for the same reason, so both the first render
  // and a filter applied to a drawn page arrive here.
  const loadedSearch = Route.useMatch({
    select: (match) => match.loaderData?.search,
  });
  const isSearchUnavailable = publicLawSearchOutage({
    hasPages: pageData !== undefined,
    isQueryOutage:
      isSearchUnavailableError(error) ||
      isSearchUnavailableError(firstPageQuery.error),
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
  // A page the reader steps to brings them to its first row once it is drawn.
  const requestPage = usePublicLawPageArrival({
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
        search: { ...search, q: entry },
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

  // No sort control where no order applies: a browse listing is newest-first
  // by definition, and an identifier lookup is answered by the identity path,
  // which ranks by relevance whatever the URL asks for. Offering a choice the
  // answer ignores would also mark the date column as sorted when it is not.
  const sortable = intent.type === "text";
  const sort: SearchSort | null = sortable
    ? decisionSortOrder(search.sort)
    : null;

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
        onRefined={searchRefinedQuery}
        onSubmit={openSingleMatch}
        query={queryInput}
      />

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
            sort === null ? undefined : (
              <DecisionSortControl
                onSortChange={(next) => {
                  detached(
                    searchNavigation((previous) => ({
                      ...previous,
                      sort: next,
                    })),
                    "cases.sort-navigate",
                  );
                }}
                sort={sort}
              />
            )
          }
          summary={
            // The widened-search note sits on the count's line, not on a
            // line of its own: it qualifies the count, and a row between the
            // toolbar and the table pushed every result down for one clause.
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <ListHeading
                exactCount={exact.length}
                intent={intent}
                isRefreshing={isRefreshing}
                page={pager.currentPage}
                total={searchTotal}
              />
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
          <SearchUnavailable
            onRetry={() => {
              detached(
                Promise.all([refetch(), firstPageQuery.refetch()]),
                "cases.search-retry",
              );
            }}
          />
        ) : (
          <>
            <DecisionTable
              decisions={find.rows}
              emptyState={
                warnings.emptyState === null ? undefined : (
                  <NoResultsReason state={warnings.emptyState} />
                )
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
          </>
        )}
      </div>
    </main>
  );
}

type SearchWidenedLineProps = {
  line: CaseLawResultsLine;
  /** Null while the rows below answer an earlier search than the URL does. */
  onSearchEveryWord: (() => void) | null;
};

/**
 * What the search required, when it required less than the reader typed: no
 * judgment is written the way a question is asked, so the words that carry
 * the grammar of the question are not required of it.
 *
 * One muted line above the results and the way back to a search that does
 * require them. The results below are the answer, so the line stays chrome.
 */
function SearchWidenedLine({
  line,
  onSearchEveryWord,
}: SearchWidenedLineProps) {
  const t = useTranslations();

  return (
    <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 text-xs">
      {/*
        The sentence reads in the interface's own direction; only the query is
        isolated, because it is the reader's text and may run the other way.
        Isolating the whole line instead would let a Latin query set the
        direction of an Arabic sentence.
      */}
      <p className="min-w-0">
        {t.rich(line.messageKey, {
          bdi: (chunks) => <BidiText>{chunks}</BidiText>,
          query: line.query,
        })}
      </p>
      {onSearchEveryWord === null ? null : (
        <Button onClick={onSearchEveryWord} size="xs" variant="link">
          {t(line.actionKey)}
        </Button>
      )}
    </div>
  );
}

type NoResultsReasonProps = {
  state: CaseLawEmptyState;
};

/**
 * Why the table is empty, where its rows would be. Two readings a blank table
 * cannot tell apart: the words matched nothing, or the filters cut away what
 * they matched. Only the second is something the reader can undo, so each
 * says which one it is and what to do about it.
 */
function NoResultsReason({ state }: NoResultsReasonProps) {
  const t = useTranslations();

  return (
    <div className="max-w-prose p-4">
      <p className="text-sm">{t(state.messageKey)}</p>
      <p className="text-foreground-strong-muted mt-1 text-xs">
        {t(state.hintKey)}
      </p>
    </div>
  );
}

type SearchUnavailableProps = {
  onRetry: () => void;
};

/**
 * The results region when the search backend could not be reached. It stands
 * where the grid stands, so the box and the filters above it keep working and
 * the reader's query stays in the URL for the retry to use.
 *
 * The same shape the workspace tables and the citation panels use for a read
 * that failed, rather than the page-level `EmptyScreen`: this replaces one
 * region of a drawn page, and a hero would read as the whole page being gone.
 */
function SearchUnavailable({ onRetry }: SearchUnavailableProps) {
  const t = useTranslations();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <SearchXIcon className="text-muted-foreground size-8" />
      <div className="max-w-sm">
        <p className="text-sm">{t("caseLaw.searchUnavailable.title")}</p>
        <p className="text-foreground-strong-muted mt-1 text-xs">
          {t("caseLaw.searchUnavailable.description")}
        </p>
      </div>
      <Button onClick={onRetry} size="sm" variant="secondary">
        <RefreshCwIcon />
        {t("common.retry")}
      </Button>
    </div>
  );
}

type ListHeadingProps = {
  exactCount: number;
  intent: DecisionQueryIntent;
  /** The count still answers the previous search; say so without hiding it. */
  isRefreshing: boolean;
  page: number;
  total: SearchTotal;
};

/**
 * What the list under the box is: newest first while a filter alone narrows
 * it, a choice between courts when a docket names several decisions, a count
 * for a search that could be counted.
 *
 * While a new search is in flight the line fades rather than blanking: a
 * number that disappears and comes back reads as a page reload, which is
 * exactly what is not happening.
 */
function ListHeading({ isRefreshing, ...heading }: ListHeadingProps) {
  return (
    <div
      aria-busy={isRefreshing}
      className={cn(
        "transition-opacity duration-200",
        isRefreshing && "opacity-56",
      )}
    >
      <ListHeadingText {...heading} />
    </div>
  );
}

function ListHeadingText({
  exactCount,
  intent,
  page,
  total,
}: Omit<ListHeadingProps, "isRefreshing">) {
  const t = useTranslations();
  const format = useFormatter();

  if (intent.type === "empty") {
    return (
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {page > 1
          ? t("common.page", { page: format.number(page) })
          : t("caseLaw.newestDecisions")}
      </h2>
    );
  }
  if (intent.type === "identifier" && exactCount > 1) {
    return (
      <p className="text-xs">
        {t("caseLaw.sameCaseNumber", { count: exactCount })}
      </p>
    );
  }
  switch (total.type) {
    case SEARCH_TOTAL_TYPE.EXACT:
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.pageWithResultCount", {
            count: total.count,
            page: format.number(page),
          })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.ESTIMATE:
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.pageWithEstimatedResultCount", {
            count: total.count,
            page: format.number(page),
          })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.NOT_COUNTED:
      return (
        <p className="text-xs tabular-nums">
          {t("common.page", { page: format.number(page) })}
        </p>
      );
    default:
      total satisfies never;
      return panic("Unhandled search total");
  }
}
