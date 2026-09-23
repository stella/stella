import { useRef, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
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
import { RefreshCwIcon, SearchXIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  type DecisionQueryIntent,
  exactDecisionMatches,
} from "@stll/api-contract/decision-query-intent";
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
import { cn } from "@stll/ui/utils";

import { PublicLawPager } from "@/components/public-law-table/public-law-pager";
import {
  publicLawPageIndex,
  publicLawPageNumber,
  publicLawPagerModel,
  publicLawPageSearchSchema,
  publicLawPageSearchValue,
  publicLawPageSize,
  publicLawPageSizeSearchSchema,
  publicLawPageSizeSearchValue,
  publicLawPagesToWalk,
  reachablePublicLawPage,
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
  publicCaseLawCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
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
import { decisionFilterFacets } from "@/features/case-law/decision-filter-facets";
import type { DecisionFilterFacets } from "@/features/case-law/decision-filter-facets.logic";
import { useOpenDecisionInspector } from "@/features/case-law/decision-row-host";
import {
  caseLawCountryScope,
  createDecisionFiltersFromSearch,
  openDecisionMatch,
  readDecisionIntent,
} from "@/features/case-law/open-decision-match";
import {
  decisionFacetsOptions,
  decisionsInfiniteOptions,
} from "@/features/case-law/queries/decisions";
import type { CaseLawBrowseFacets } from "@/features/case-law/queries/decisions";
import {
  QuestionColumnControls,
  useQuestionColumns,
} from "@/features/case-law/research/question-columns-controller";
import { caseLawWarningSurfaces } from "@/features/case-law/search-warnings.logic";
import type {
  CaseLawEmptyState,
  CaseLawResultsLine,
} from "@/features/case-law/search-warnings.logic";
import { useDecisionFind } from "@/features/case-law/use-decision-find";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { getMessageLocale } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
  resolveCaseLawRouteCountry,
} from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
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
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { ssrStatusHeaders } from "@/ssr-response-status";

/** What the route accepts in `q`, and therefore what the field may hold. */
const MAX_QUERY_LENGTH = 256;

/** Stable empties, so an unchanged page does not hand the table new arrays. */
const EMPTY_SELECTION: readonly string[] = [];
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
  page: publicLawPageSearchSchema,
  pageSize: publicLawPageSizeSearchSchema,
  q: optionalBrowseStringSchema(MAX_QUERY_LENGTH),
  // A link is public and may be edited by hand or by a crawler; an order this
  // build does not know is not an error page, it is the default order.
  sort: v.fallback(v.optional(v.picklist(SEARCH_SORTS)), undefined),
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

const createCaseLawIndexDescription = (search: CaseLawIndexSearch): string => {
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
    return `Public case-law database for ${scope}, with indexable court decisions and legal source materials.`;
  }

  return "Public case-law database with indexable court decisions and legal source materials.";
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
  if (Result.isError(result)) {
    return isSearchUnavailableError(result.error)
      ? null
      : await Promise.reject(result.error);
  }
  return result.value;
};

/**
 * The page the document describes: its rows are what the crawler reads and
 * what the collection markup lists. Empty while a background load has not
 * produced that page yet, which only a reader with JavaScript ever sees.
 */
const shownDecisions = (
  walked: { pages: readonly { decisions: Decision[] }[] } | undefined,
  page: number | undefined,
): Decision[] => {
  if (walked === undefined) {
    return [];
  }
  const shown = walked.pages.at(
    publicLawPageIndex(publicLawPageNumber(page), walked.pages.length),
  );
  return shown ? shown.decisions : [];
};

export const Route = createFileRoute("/law/cases/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
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
    // links spell it, and a page the chain of cursors reaches. The corpus
    // answers with cursors, so page N exists only once the pages before it
    // have been fetched — but a reload, a shared URL, a new tab and a crawler
    // all arrive with no chain at all, and correcting them to the first page
    // would make the pager's real links unshareable. So a deep link walks the
    // chain to the page it names, and only a page the results themselves do
    // not reach falls back to the deepest one that does. One redirect for
    // both, so the reader is corrected once.
    const filters = createDecisionFiltersFromSearch(
      { ...search, country: countryParam },
      // The excerpt length lives in the reader's browser, which the router
      // cannot reach here. Priming the default keeps this walk on the entry
      // the reader's first page will read when they never changed it.
      { excerpt: DEFAULT_SEARCH_EXCERPT },
    );
    const decisionsOptions = decisionsInfiniteOptions(
      filters,
      publicLawPageSize(search.pageSize),
    );
    const walked =
      queryClient.getQueryData(decisionsOptions.queryKey)?.pages.length ?? 0;
    const wanted = publicLawPageNumber(search.page);
    // Only a deep arrival pays for the walk. A first page, and a page the
    // chain already holds, leave the fetching to the loader, which decides
    // whether this navigation is worth awaiting at all.
    let reached = walked;
    if (wanted > 1 && wanted > walked) {
      const chain = await resultsOrOutage(
        ensureRouteInfiniteQueryData(queryClient, {
          ...decisionsOptions,
          pages: publicLawPagesToWalk(wanted, walked),
        }),
      );
      // An outage proves nothing about which pages exist, so the walk stops
      // where it is and the URL keeps the page the reader linked to: the
      // results region says the search is down, and correcting them to page
      // one would lose the link to a failure that passes. The loader walks the
      // same chain, so a backend that recovers in between still answers for
      // the page this URL names rather than serving page one under it.
      reached = chain === null ? wanted : chain.pages.length;
    }
    const page = publicLawPageSearchValue(
      reachablePublicLawPage(wanted, reached),
    );
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
    const decisionsOptions = decisionsInfiniteOptions(
      // The default again: a loader has no browser storage to read the
      // reader's length from, and a reader who never changed it lands on the
      // entry this primes.
      createDecisionFiltersFromSearch(deps, {
        excerpt: DEFAULT_SEARCH_EXCERPT,
      }),
      publicLawPageSize(deps.pageSize),
    );
    const mode = publicLawLoadMode({
      cause,
      hasCachedPages:
        queryClient.getQueryData(decisionsOptions.queryKey) !== undefined,
    });

    // A filter, a sort or a page step on a page that is already drawn: the
    // toolbar, the headers and the pager are all still correct, so awaiting
    // the new rows here would replace a live page with a skeleton for
    // nothing. The components hold the previous rows and swap them in place.
    if (mode === "background") {
      return {
        decisions: shownDecisions(
          queryClient.getQueryData(decisionsOptions.queryKey),
          deps.page,
        ),
        search: PUBLIC_LAW_SEARCH_STATE.answered,
      };
    }

    // `beforeLoad` has already walked the chain to the page a deep link named,
    // so this is a cache read for that case and the first fetch otherwise —
    // except when its walk hit an outage, which leaves the chain unwalked
    // behind a URL that still names a later page. Asking for the pages this
    // page needs is what keeps the rows and the URL the same page.
    const walked =
      queryClient.getQueryData(decisionsOptions.queryKey)?.pages.length ?? 0;
    const wanted = publicLawPageNumber(deps.page);
    const [decisionPages] = await Promise.all([
      resultsOrOutage(
        ensureRouteInfiniteQueryData(queryClient, {
          ...decisionsOptions,
          ...(wanted > 1 &&
            wanted > walked && {
              pages: publicLawPagesToWalk(wanted, walked),
            }),
        }),
      ),
      ensureRouteQueryData(queryClient, decisionFacetsOptions(scope)),
    ]);

    // The rows are one region of this page, so a search backend that cannot be
    // reached is that region's failure and not the route's: the box and the
    // filters are the URL's own and stay usable. Every other failure is still
    // the error boundary's.
    if (decisionPages === null) {
      return { decisions: [], search: PUBLIC_LAW_SEARCH_STATE.unavailable };
    }

    return {
      decisions: shownDecisions(decisionPages, deps.page),
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
    const search = match.search;
    const title = pageTitle("common.caseLaw");
    const description = createCaseLawIndexDescription(search);
    const path = createCaseLawIndexPath(search);

    return createPublicLawHead({
      description,
      jsonLd: createLegalCollectionJsonLd({
        aboutName: "Case-law decisions",
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
      strict,
      to,
      type,
      year,
    }),
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
  const filters = createDecisionFiltersFromSearch(search, {
    excerpt: layout.excerpt,
  });

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
  // Read, not suspended on: the loader primes this only on a cold arrival, and
  // a jurisdiction switch must not take the whole page down for a list of
  // court names. The previous facets stay until the new ones land.
  const { data: browseFacets } = useQuery({
    ...decisionFacetsOptions(scope),
    placeholderData: keepPreviousData,
  });
  const decisionsOptions = decisionsInfiniteOptions(filters, pageSize);
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isPlaceholderData,
    refetch,
  } = useInfiniteQuery({
    ...decisionsOptions,
    // The chain the reader has walked stays loaded while the filters change,
    // so stepping between pages never blanks the table.
    placeholderData: keepPreviousData,
  });
  // A backend that cannot be reached is this region's failure, not the page's.
  // The loader lets it through for the same reason, so both the first render
  // and a filter applied to a drawn page arrive here.
  const loadedSearch = Route.useMatch({
    select: (match) => match.loaderData?.search,
  });
  const isSearchUnavailable = publicLawSearchOutage({
    hasPages: data !== undefined,
    isQueryOutage: isSearchUnavailableError(error),
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

  // One page of the chain is on screen, never the chain itself: the pages
  // behind the reader are cursors kept for the links, not rows to draw.
  const walkedPageCount = data?.pages.length ?? 0;
  const wantedPage = publicLawPageNumber(search.page);

  // The router walked the default length's chain, because the length the
  // reader chose lives in their browser and `beforeLoad` cannot read it. A
  // reader who chose another length therefore arrives on a chain holding one
  // page while the URL names a deeper one, and the pager would clamp to what
  // the chain reaches. The length changes neither which decisions match nor
  // the order they match in, so page N of this chain is page N of the one the
  // router walked: the same pages exist here and are walked once, on arrival.
  const walkToWantedPage = useLatestCallback(
    async () =>
      await ensureRouteInfiniteQueryData(queryClient, {
        ...decisionsOptions,
        pages: publicLawPagesToWalk(wantedPage, walkedPageCount),
      }),
  );
  useExternalSyncEffect(() => {
    if (wantedPage <= walkedPageCount) {
      return;
    }
    detached(walkToWantedPage(), "cases.walk-chosen-excerpt");
  }, [walkToWantedPage, walkedPageCount, wantedPage]);

  const pager = publicLawPagerModel({
    hasNextPage,
    page: wantedPage,
    walkedPageCount,
  });
  const decisions: readonly Decision[] =
    data?.pages.at(pager.currentPage - 1)?.decisions ?? EMPTY_DECISIONS;
  // The named decision first, when the entry named one; the same docket at
  // several courts stays several rows the reader chooses between.
  const exact =
    intent.type === "identifier"
      ? exactDecisionMatches(intent.value, decisions)
      : [];
  const exactIds = new Set(exact.map((decision) => decision.id));
  const ordered =
    exact.length === 0
      ? decisions
      : [...exact, ...decisions.filter((d) => !exactIds.has(d.id))];

  const searchTotal = data?.pages.at(0)?.total ?? SEARCH_TOTAL_NOT_COUNTED;
  // What the search said about itself, read off the first page: a warning is
  // about the result set, not about the page of it the reader is looking at.
  // The wire's own English sentences are never drawn; the code picks the keys
  // and the reader's language renders them.
  const warnings = caseLawWarningSurfaces(data?.pages.at(0)?.answered ?? null);
  const facets: DecisionFilterFacets = decisionFilterFacets({
    browse: browseFacets ?? NO_BROWSE_FACETS,
    search: data?.pages.at(0)?.facets ?? null,
  });

  // A pending debounced query write holds text the URL has not seen yet.
  // Letting it land after this navigation would re-apply the old field value
  // to the new filters; cancelling it alone would strand the edit for good,
  // because `search.q` never changes and the field never resyncs. So the
  // pending text is folded in first and the caller's own change applied over
  // it. Returns the navigation so each caller tags it with a literal label.
  //
  // Every such change also drops the page: the cursors were cut for the old
  // result set, so page 3 of it names nothing in the new one.
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

  /**
   * The page after the chain: its cursor is the one the last walked page
   * named, so it is fetched first and only then does the URL move on to it.
   */
  const walkForward = () => {
    detached(
      (async () => {
        const result = await fetchNextPage();
        const walked = result.data?.pages.length ?? walkedPageCount;
        if (walked <= walkedPageCount) {
          return;
        }
        await navigate({
          search: (previous) => ({
            ...previous,
            page: publicLawPageSearchValue(walked),
          }),
        });
      })(),
      "cases.walk-next-page",
    );
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
  });
  // Find-in-table over the page on screen, beside the control that narrows the
  // search itself. Kept per jurisdiction, the way the arrangement is.
  const columnGroups = useDecisionColumnGroups({
    questions: questions.surface,
  });
  const find = useDecisionFind({
    decisions: ordered,
    layout,
    paneRef,
    questions: questions.surface,
    surfaceKey: countryParam,
  });

  const setPageSize = (next: PublicLawPageSize) => {
    detached(
      searchNavigation((previous) => ({
        ...previous,
        pageSize: publicLawPageSizeSearchValue(next),
      })),
      "cases.page-size-navigate",
    );
  };

  // The same search with every word required. It leaves the URL like every
  // other change here — the pending field text folded in, the page dropped —
  // because the words it requires are a different result set.
  const searchEveryWord = () => {
    detached(
      searchNavigation((previous) => ({
        ...previous,
        strict: STRICT_SEARCH_VALUE,
      })),
      "cases.strict-navigate",
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
      value: chipValue(key, value, format),
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
        maxLength={MAX_QUERY_LENGTH}
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
              detached(refetch(), "cases.search-retry");
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
              selectedIds={selectedIds}
            />
            <PublicLawPager
              isWalking={isFetchingNextPage}
              model={pager}
              onPageSizeChange={setPageSize}
              onWalkForward={walkForward}
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

  if (intent.type === "empty") {
    return (
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {page > 1
          ? t("caseLaw.pagination.page", { page: String(page) })
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
            page: String(page),
          })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.ESTIMATE:
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.pageWithEstimatedResultCount", {
            count: total.count,
            page: String(page),
          })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.NOT_COUNTED:
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.page", { page: String(page) })}
        </p>
      );
    default:
      total satisfies never;
      return panic("Unhandled search total");
  }
}
