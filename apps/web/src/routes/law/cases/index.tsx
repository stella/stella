import { useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { panic } from "better-result";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  type DecisionQueryIntent,
  exactDecisionMatches,
} from "@stll/api-contract/decision-query-intent";
import {
  SEARCH_SORTS,
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
  type SearchSort,
  type SearchTotal,
} from "@stll/api-contract/search";
import { Temporal } from "@stll/time";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import {
  CASE_LAW_FILTER_KEYS,
  clearedCaseLawFilters,
  createCaseLawIndexPath,
  decisionDateRange,
  decisionSortOrder,
  hasActiveCaseLawFilter,
  validDecisionDate,
  withPendingQuery,
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
import {
  DecisionFacetRail,
  DecisionFacetRailSkeleton,
} from "@/features/case-law/components/decision-facet-rail";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import { DecisionPager } from "@/features/case-law/components/decision-pager";
import {
  DecisionFilterChips,
  DecisionResultsToolbar,
} from "@/features/case-law/components/decision-results-toolbar";
import type { DecisionFilterChip } from "@/features/case-law/components/decision-results-toolbar";
import { DecisionTable } from "@/features/case-law/components/decision-table";
import type { Decision } from "@/features/case-law/components/decision-table";
import { useDecisionColumnPreferences } from "@/features/case-law/decision-column-preferences";
import { DEFAULT_DECISION_TABLE_LAYOUT } from "@/features/case-law/decision-column-preferences.logic";
import {
  decisionPageIndex,
  decisionPageNumber,
  decisionPagerModel,
  decisionPageSearchValue,
  decisionPageSize,
  decisionPageSizeSearchValue,
  reachableDecisionPage,
} from "@/features/case-law/decision-pagination.logic";
import type { DecisionPageSize } from "@/features/case-law/decision-pagination.logic";
import { decisionsLoadMode } from "@/features/case-law/decisions-load-mode.logic";
import type { DecisionRailFacets } from "@/features/case-law/facet-rail.logic";
import { SaveIntoMatterAction } from "@/features/case-law/matter-links/save-into-matter";
import { openDecisionAtPassage } from "@/features/case-law/open-decision-at-passage";
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
import { railFacets } from "@/features/case-law/rail-facets";
import {
  QuestionColumnControls,
  useQuestionColumns,
} from "@/features/case-law/research/question-columns-controller";
import { NO_QUESTION_COLUMNS } from "@/features/case-law/research/question-columns.logic";
import {
  addRefineTerm,
  canonicalRefinements,
  queryWithRefinements,
  refineTermsOfQuery,
  removeRefineTerm,
} from "@/features/case-law/search-refine.logic";
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
  createLegalCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";

/** What the route accepts in `q`, and therefore what the field may hold. */
const MAX_QUERY_LENGTH = 256;
const MAX_REFINEMENT_LENGTH = 240;

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

const optionalRefinementsSchema = v.fallback(
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(MAX_REFINEMENT_LENGTH),
      v.transform(canonicalRefinements),
    ),
  ),
  undefined,
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
 * Which page of the results, and how large a page is. Both are dropped from
 * the URL at their default, and both are read leniently: a public link may be
 * typed or crawled, and a page number nobody can reach is the first page, not
 * an error screen.
 */
const optionalPageSchema = v.fallback(
  v.optional(
    v.pipe(
      v.union([v.number(), v.string()]),
      v.transform((value) => decisionPageNumber(Number(value))),
      v.transform((page) => decisionPageSearchValue(page)),
    ),
  ),
  undefined,
);

const optionalPageSizeSchema = v.fallback(
  v.optional(
    v.pipe(
      v.union([v.number(), v.string()]),
      v.transform((value) => decisionPageSize(Number(value))),
      v.transform((pageSize) => decisionPageSizeSearchValue(pageSize)),
    ),
  ),
  undefined,
);

const searchSchema = v.object({
  country: optionalBrowseStringSchema(3),
  court: optionalBrowseStringSchema(512),
  from: optionalDateSchema,
  lang: optionalBrowseStringSchema(16),
  page: optionalPageSchema,
  pageSize: optionalPageSizeSchema,
  q: optionalBrowseStringSchema(MAX_QUERY_LENGTH),
  // A link is public and may be edited by hand or by a crawler; an order this
  // build does not know is not an error page, it is the default order.
  sort: v.fallback(v.optional(v.picklist(SEARCH_SORTS)), undefined),
  source: optionalBrowseStringSchema(128),
  to: optionalDateSchema,
  type: optionalBrowseStringSchema(128),
  within: optionalRefinementsSchema,
  // Accepted, never written: links made before the range existed still work,
  // and `decisionDateRange` resolves them to that year's whole span.
  year: optionalBrowseStringSchema(4),
});

type CaseLawIndexSearch = v.InferOutput<typeof searchSchema>;

/** Which facet a chip belongs to, for the label the chip carries. */
const FILTER_KIND_LABEL_KEYS = {
  court: "common.court",
  lang: "common.language",
  source: "common.source",
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
    case "source":
      return { ...previous, source: value };
    case "type":
      return { ...previous, type: value };
    default:
      key satisfies never;
      return panic(`Unhandled case-law filter: ${String(key)}`);
  }
};

/**
 * What a chip shows for a selected value. A source is an opaque id the facets
 * attach a name to, and a language is a code; every other facet's value is
 * already the words the reader picked off the rail.
 */
const chipValue = (
  key: CaseLawFilterKey,
  value: string,
  {
    facets,
    format,
  }: { facets: DecisionRailFacets; format: ReturnType<typeof useFormatter> },
): string => {
  switch (key) {
    case "lang":
      return languageLabel(format, value);
    case "source":
      return (
        facets.source.find((bucket) => bucket.value === value)?.label ?? value
      );
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
    decisionPageIndex(decisionPageNumber(page), walked.pages.length),
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
  beforeLoad: ({ context: { queryClient }, search }) => {
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
      search.within === undefined &&
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
    // links spell it, and a page whose cursor this browser has walked to. A
    // page exists for a reader only once the page before it has been fetched,
    // so a link to a deeper one — a reload, a shared URL, a crawler — resolves
    // to the deepest page the chain can show rather than to an empty table.
    // One redirect for both, so the reader is corrected once.
    const filters = createDecisionFiltersFromSearch({
      ...search,
      country: countryParam,
    });
    const walked =
      queryClient.getQueryData(
        decisionsInfiniteOptions(filters, decisionPageSize(search.pageSize))
          .queryKey,
      )?.pages.length ?? 0;
    const page = decisionPageSearchValue(
      reachableDecisionPage(search.page ?? 1, walked),
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
      createDecisionFiltersFromSearch(deps),
      decisionPageSize(deps.pageSize),
    );
    const mode = decisionsLoadMode({
      cause,
      hasCachedPages:
        queryClient.getQueryData(decisionsOptions.queryKey) !== undefined,
    });

    // A filter, a sort or a refinement on a page that is already drawn: the
    // rail, the toolbar, the headers and the pager are all still correct, so
    // awaiting the new rows here would replace a live page with a skeleton for
    // nothing. The components hold the previous rows and swap them in place.
    if (mode === "background") {
      return {
        decisions: shownDecisions(
          queryClient.getQueryData(decisionsOptions.queryKey),
          deps.page,
        ),
      };
    }

    const [decisionPages] = await Promise.all([
      ensureRouteInfiniteQueryData(queryClient, decisionsOptions),
      ensureRouteQueryData(queryClient, decisionFacetsOptions(scope)),
    ]);

    return { decisions: shownDecisions(decisionPages, deps.page) };
  },
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
  component: PublicCaseLawIndex,
  pendingComponent: PublicCaseLawIndexPending,
});

// Only a cold arrival reaches this: a filter, a sort or a page step keeps the
// real page and swaps its rows. The shape is the real one — same heading, same
// search row, rail, count line, table header and pager — so the values shimmer
// into the layout they will occupy rather than the layout jumping around them.
function PublicCaseLawIndexPending() {
  const t = useTranslations();
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="sr-only">{t("common.caseLaw")}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-40 rounded-md" />
        <Skeleton className="h-9 w-full max-w-md flex-1 rounded-md" />
      </div>
      <div className="flex min-w-0 flex-1 items-start gap-6">
        <DecisionFacetRailSkeleton />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Skeleton className="h-7 w-full max-w-sm" />
          {/*
            The defaults, not the reader's stored choice: storage is not
            readable during SSR, and a header that changes on hydration is a
            worse shift than one that occasionally shows a column too many.
          */}
          <DecisionTable
            decisions={[]}
            isLoading
            layout={DEFAULT_DECISION_TABLE_LAYOUT}
            onLayoutChange={() => undefined}
            onSelectedIdsChange={() => undefined}
            order="newest"
            questions={null}
            selectedIds={EMPTY_SELECTION}
          />
          <Skeleton className="h-8 w-full max-w-sm" />
        </div>
      </div>
    </main>
  );
}

function PublicCaseLawIndex() {
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
      source,
      to,
      type,
      within,
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
      source,
      to,
      type,
      within,
      year,
    }),
  });
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();

  const scope =
    publicCaseLawCountryFromParam(search.country) ??
    panic("The case-law route rendered without a launch-ready country.");
  const countryParam = toCaseLawCountryParam(scope);
  const effectiveQuery = queryWithRefinements(search.q, search.within);
  const intent = readDecisionIntent(effectiveQuery, { jurisdiction: scope });
  const filters = createDecisionFiltersFromSearch(search);

  const [queryInput, setQueryInput] = useState(search.q ?? "");
  // What the field last asked the URL to hold. A navigation that lands on
  // this value is the field's own write coming back, not somebody else's.
  const [requestedQuery, setRequestedQuery] = useState(search.q ?? "");
  const writeQuery = useDebouncedCallback((value: string) => {
    detached(
      navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          q: value.trim() ? value : undefined,
        }),
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

  const { layout, setLayout } = useDecisionColumnPreferences(countryParam);

  const pageSize = decisionPageSize(search.pageSize);
  // Read, not suspended on: the loader primes this only on a cold arrival, and
  // a jurisdiction switch must not take the whole page down for a list of
  // court names. The previous rail stays until the new one lands.
  const { data: browseFacets } = useQuery({
    ...decisionFacetsOptions(scope),
    placeholderData: keepPreviousData,
  });
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isPlaceholderData,
  } = useInfiniteQuery({
    ...decisionsInfiniteOptions(filters, pageSize),
    // The chain the reader has walked stays loaded while the filters change,
    // so stepping between pages never blanks the table.
    placeholderData: keepPreviousData,
  });
  // The rows on screen answer the search before this one. Everything else on
  // the page is already the new search's, so the rows say so themselves rather
  // than the page being replaced.
  const isRefreshing = isPlaceholderData;

  // One page of the chain is on screen, never the chain itself: the pages
  // behind the reader are cursors kept for the links, not rows to draw.
  const walkedPageCount = data?.pages.length ?? 0;
  const pager = decisionPagerModel({
    hasNextPage,
    page: decisionPageNumber(search.page),
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
  const facets = railFacets({
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
            page: decisionPageSearchValue(walked),
          }),
        });
      })(),
      "cases.walk-next-page",
    );
  };

  // Picked rows narrow a run to them; the page they belong to is the only
  // page they mean anything on, so a step forward clears them.
  const [selectedIds, setSelectedIds] =
    useState<readonly string[]>(EMPTY_SELECTION);
  const [selectionPage, setSelectionPage] = useState(pager.currentPage);
  if (selectionPage !== pager.currentPage) {
    setSelectionPage(pager.currentPage);
    setSelectedIds(EMPTY_SELECTION);
  }
  const pageDecisionIds = decisions.map((decision) => decision.id);
  const questions = useQuestionColumns({
    onShowSource: (decision, anchorId) => {
      detached(
        openDecisionAtPassage(routerNavigate, decision, anchorId),
        "cases.show-source",
      );
    },
    pageDecisionIds,
    selectedDecisionIds: selectedIds,
  });

  const setPageSize = (next: DecisionPageSize) => {
    detached(
      searchNavigation((previous) => ({
        ...previous,
        pageSize: decisionPageSizeSearchValue(next),
      })),
      "cases.page-size-navigate",
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

  const refineTerms = refineTermsOfQuery(search.within);
  const dateRange = decisionDateRange(search);
  const chips: DecisionFilterChip[] = [];
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
      value: chipValue(key, value, { facets, format }),
    });
  }
  for (const term of refineTerms) {
    chips.push({
      id: `refine:${term}`,
      onRemove: () => {
        detached(
          searchNavigation((previous) => ({
            ...previous,
            within: removeRefineTerm(previous.within, term),
          })),
          "cases.remove-refinement-navigate",
        );
      },
      value: `"${term}"`,
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
        navigate: routerNavigate,
        queryClient,
        search: { ...search, q: entry },
        uiLocale,
      }),
      "cases.open-match",
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
  const order = intent.type === "empty" ? "newest" : (sort ?? "relevance");

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
        onSubmit={openSingleMatch}
        query={queryInput}
      />

      <div className="flex min-w-0 flex-1 items-start gap-6">
        <DecisionFacetRail
          dateRange={dateRange}
          facets={facets}
          onDateRangeChange={setDateRange}
          onSelect={selectFacet}
          selection={{
            court: search.court,
            lang: search.lang,
            source: search.source,
            type: search.type,
          }}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <DecisionResultsToolbar
            actions={
              <>
                <QuestionColumnControls controller={questions} />
                <SaveIntoMatterAction
                  pageDecisionIds={pageDecisionIds}
                  selectedDecisionIds={selectedIds}
                />
              </>
            }
            layout={layout}
            onLayoutChange={setLayout}
            onRefine={(entry) => {
              detached(
                searchNavigation((previous) => ({
                  ...previous,
                  within: addRefineTerm(previous.within, entry),
                })),
                "cases.refine-navigate",
              );
            }}
            onSortChange={(next) => {
              detached(
                searchNavigation((previous) => ({ ...previous, sort: next })),
                "cases.sort-navigate",
              );
            }}
            questionColumns={
              questions.surface === null
                ? NO_QUESTION_COLUMNS
                : questions.surface.columns
            }
            sort={sort}
            summary={
              <ListHeading
                exactCount={exact.length}
                intent={intent}
                isRefreshing={isRefreshing}
                page={pager.currentPage}
                total={searchTotal}
              />
            }
          />

          <DecisionFilterChips
            chips={chips}
            onClearAll={() => {
              // Clear the chips, not the query the reader typed into the main
              // field. Refinements have their own URL field, so the visible
              // query and the result set cannot diverge here.
              detached(
                searchNavigation((previous) => ({
                  ...previous,
                  ...clearedCaseLawFilters(),
                  within: undefined,
                })),
                "cases.clear-filters",
              );
            }}
          />

          <DecisionTable
            decisions={ordered}
            isLoading={isLoading}
            isRefreshing={isRefreshing}
            layout={layout}
            onLayoutChange={setLayout}
            onSelectedIdsChange={setSelectedIds}
            order={order}
            query={effectiveQuery}
            questions={questions.surface}
            selectedIds={selectedIds}
          />
          <DecisionPager
            isWalking={isFetchingNextPage}
            model={pager}
            onPageSizeChange={setPageSize}
            onWalkForward={walkForward}
            pageSize={pageSize}
          />
        </div>
      </div>
    </main>
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
