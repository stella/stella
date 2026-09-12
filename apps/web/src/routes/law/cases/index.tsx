import { useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  useSuspenseQuery,
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
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
  type SearchTotal,
} from "@stll/api-contract/search";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import { PublicLawCountryMenu } from "@/components/public-law-country-menu";
import {
  CASE_LAW_FILTER_KEYS,
  clearedCaseLawFilters,
  createCaseLawIndexPath,
  DECISION_SORT_ORDERS,
  decisionSortOrder,
  hasActiveCaseLawFilter,
  validDecisionYear,
} from "@/features/case-law/case-law-index-search.logic";
import type {
  CaseLawFilterKey,
  DecisionSortOrder,
} from "@/features/case-law/case-law-index-search.logic";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountryFromParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { CaseLawBrowseLinks } from "@/features/case-law/components/case-law-browse-links";
import {
  CaseLawSearch,
  caseLawCountryName,
} from "@/features/case-law/components/case-law-search";
import {
  DecisionFacetRail,
  DecisionFacetRailSkeleton,
} from "@/features/case-law/components/decision-facet-rail";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import {
  DecisionFilterChips,
  DecisionResultsToolbar,
} from "@/features/case-law/components/decision-results-toolbar";
import type { DecisionFilterChip } from "@/features/case-law/components/decision-results-toolbar";
import { DecisionTable } from "@/features/case-law/components/decision-table";
import type { Decision } from "@/features/case-law/components/decision-table";
import { DEFAULT_HIDDEN_DECISION_COLUMN_IDS } from "@/features/case-law/decision-columns.logic";
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
import { railFacets } from "@/features/case-law/rail-facets";
import { ResearchTableActions } from "@/features/case-law/research/research-actions";
import {
  addRefineTerm,
  refineTermsOfQuery,
  removeRefineTerm,
} from "@/features/case-law/search-refine.logic";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { getMessageLocale } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import {
  setHiddenDecisionColumnIds,
  useHiddenDecisionColumnIds,
} from "@/lib/case-law-column-preferences";
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

const optionalBrowseStringSchema = (maxLength: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(maxLength),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  );

const searchSchema = v.object({
  country: optionalBrowseStringSchema(3),
  court: optionalBrowseStringSchema(512),
  lang: optionalBrowseStringSchema(16),
  q: optionalBrowseStringSchema(MAX_QUERY_LENGTH),
  // A link is public and may be edited by hand or by a crawler; an order this
  // build does not know is not an error page, it is the default order.
  sort: v.fallback(v.optional(v.picklist(DECISION_SORT_ORDERS)), undefined),
  source: optionalBrowseStringSchema(128),
  type: optionalBrowseStringSchema(128),
  year: optionalBrowseStringSchema(4),
});

type CaseLawIndexSearch = v.InferOutput<typeof searchSchema>;

/** Which facet a chip belongs to, for the label the chip carries. */
const FILTER_KIND_LABEL_KEYS = {
  court: "common.court",
  lang: "common.language",
  source: "common.source",
  type: "common.type",
  year: "workspaces.views.calendar.year",
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
    case "year":
      return { ...previous, year: value };
    default:
      key satisfies never;
      return panic(`Unhandled case-law filter: ${String(key)}`);
  }
};

const createCaseLawIndexDescription = ({
  country,
  court,
  year,
}: CaseLawIndexSearch): string => {
  const scope = [court, caseLawCountryScope(country), validDecisionYear(year)]
    .filter(Boolean)
    .join(", ");
  if (scope) {
    return `Public case-law database for ${scope}, with indexable court decisions and legal source materials.`;
  }

  return "Public case-law database with indexable court decisions and legal source materials.";
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
  beforeLoad: ({ search }) => {
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

    if (search.country !== countryParam) {
      throw redirect({
        to: "/law/cases",
        search: { ...search, country: countryParam },
        replace: true,
      });
    }
  },
  loader: async ({ context: { queryClient }, deps }) => {
    const scope =
      publicCaseLawCountryFromParam(deps.country) ??
      panic("The case-law route loaded without a launch-ready country.");
    const [decisionPages] = await Promise.all([
      ensureRouteInfiniteQueryData(
        queryClient,
        decisionsInfiniteOptions(createDecisionFiltersFromSearch(deps)),
      ),
      ensureRouteQueryData(queryClient, decisionFacetsOptions(scope)),
    ]);

    const firstPage = decisionPages.pages.at(0);
    return { decisions: firstPage ? firstPage.decisions : [] };
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

// The loader fetches decisions and facets, so without a pendingComponent the
// route flashes the glowing logo. Reuse the real page chrome — rail, toolbar
// and the table's own header — so only the values shimmer in.
function PublicCaseLawIndexPending() {
  const t = useTranslations();
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("common.caseLaw")}</h1>
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
            hiddenColumnIds={DEFAULT_HIDDEN_DECISION_COLUMN_IDS}
            isLoading
            order="newest"
          />
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
    select: ({ country, court, lang, q, sort, source, type, year }) => ({
      country,
      court,
      lang,
      q,
      sort,
      source,
      type,
      year,
    }),
  });
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();

  const scope =
    publicCaseLawCountryFromParam(search.country) ??
    panic("The case-law route rendered without a launch-ready country.");
  const countryParam = toCaseLawCountryParam(scope);
  const intent = readDecisionIntent(search.q, { jurisdiction: scope });
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

  const hiddenColumnIds = useHiddenDecisionColumnIds(countryParam);

  const { data: browseFacets } = useSuspenseQuery(decisionFacetsOptions(scope));
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      ...decisionsInfiniteOptions(filters),
      placeholderData: keepPreviousData,
    });

  const decisions: Decision[] = [];
  if (data) {
    for (const page of data.pages) {
      decisions.push(...page.decisions);
    }
  }
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
    browse: browseFacets,
    search: data?.pages.at(0)?.facets ?? null,
  });

  // A pending debounced query write would otherwise land after a filter
  // navigation and re-apply the old field value to the new filters. Returns
  // the navigation so each caller tags it with its own literal label.
  const searchNavigation = async (
    nextSearch: (previous: CaseLawIndexSearch) => CaseLawIndexSearch,
  ) => {
    writeQuery.cancel();
    await navigate({ replace: true, search: nextSearch });
  };

  const selectFacet = (key: CaseLawFilterKey, value: string | undefined) => {
    detached(
      searchNavigation((previous) => withFilter(previous, key, value)),
      "cases.filter-navigate",
    );
  };

  const setQuery = (next: string | undefined) => {
    setQueryInput(next ?? "");
    setRequestedQuery((next ?? "").trim());
    detached(
      searchNavigation((previous) => ({ ...previous, q: next })),
      "cases.refine-navigate",
    );
  };

  const refineTerms = refineTermsOfQuery(search.q);
  const chips: DecisionFilterChip[] = [];
  for (const key of CASE_LAW_FILTER_KEYS) {
    const value = search[key];
    if (value === undefined) {
      continue;
    }
    chips.push({
      id: `filter:${key}`,
      kind: t(FILTER_KIND_LABEL_KEYS[key]),
      onRemove: () => selectFacet(key, undefined),
      value: key === "lang" ? languageLabel(format, value) : value,
    });
  }
  for (const term of refineTerms) {
    chips.push({
      id: `refine:${term}`,
      onRemove: () => setQuery(removeRefineTerm(search.q, term)),
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

  const browsing = intent.type === "empty";
  const sort: DecisionSortOrder | null = browsing
    ? null
    : decisionSortOrder(search.sort);
  const order = sort ?? "newest";

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("common.caseLaw")}</h1>
        <ResearchTableActions filters={filters} />
      </div>

      <PublicLawCountryMenu
        countries={PUBLIC_CASE_LAW_COUNTRIES.map((code) => ({
          label: caseLawCountryName(format, code),
          value: toCaseLawCountryParam(code),
        }))}
        country={countryParam}
        onCountryChange={(country) => {
          // A court, a year or a source belongs to one corpus; carrying it
          // into another would filter by a value that corpus never uses.
          detached(
            searchNavigation((previous) => ({
              ...previous,
              ...clearedCaseLawFilters(),
              country,
            })),
            "cases.switch-country",
          );
        }}
      />

      <CaseLawSearch
        country={countryParam}
        maxLength={MAX_QUERY_LENGTH}
        onQueryChange={handleQueryChange}
        onSubmit={openSingleMatch}
        query={queryInput}
      />

      <div className="flex min-w-0 flex-1 items-start gap-6">
        <DecisionFacetRail
          facets={facets}
          onSelect={selectFacet}
          selection={{
            court: search.court,
            lang: search.lang,
            source: search.source,
            type: search.type,
            year: validDecisionYear(search.year),
          }}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <DecisionResultsToolbar
            hiddenColumnIds={hiddenColumnIds}
            onHiddenColumnIdsChange={(next) =>
              setHiddenDecisionColumnIds(countryParam, next)
            }
            onRefine={(entry) => setQuery(addRefineTerm(search.q, entry))}
            onSortChange={(next) => {
              detached(
                searchNavigation((previous) => ({ ...previous, sort: next })),
                "cases.sort-navigate",
              );
            }}
            sort={sort}
            summary={
              <ListHeading
                exactCount={exact.length}
                intent={intent}
                total={searchTotal}
              />
            }
          />

          <DecisionFilterChips
            chips={chips}
            onClearAll={() => {
              detached(
                searchNavigation((previous) => ({
                  ...previous,
                  ...clearedCaseLawFilters(),
                })),
                "cases.clear-filters",
              );
            }}
          />

          <DecisionTable
            decisions={ordered}
            hiddenColumnIds={hiddenColumnIds}
            isLoading={isLoading}
            order={order}
            query={search.q}
          />
          {hasNextPage && (
            <div className="flex justify-center py-4">
              <Button
                disabled={isFetchingNextPage}
                onClick={() => {
                  detached(
                    (async () => await fetchNextPage())(),
                    "cases.fetch-next-page",
                  );
                }}
                variant="outline"
              >
                {isFetchingNextPage
                  ? t("caseLaw.loadingMore")
                  : t("common.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <CaseLawBrowseLinks countryParam={countryParam} facets={browseFacets} />
    </main>
  );
}

/**
 * What the list under the box is: newest first while a filter alone narrows
 * it, a choice between courts when a docket names several decisions, a count
 * for a search that could be counted.
 */
function ListHeading({
  exactCount,
  intent,
  total,
}: {
  exactCount: number;
  intent: DecisionQueryIntent;
  total: SearchTotal;
}) {
  const t = useTranslations();

  if (intent.type === "empty") {
    return (
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("caseLaw.newestDecisions")}
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
          {t("search.resultCount", { count: total.count })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.ESTIMATE:
      return (
        <p className="text-xs tabular-nums">
          {t("search.estimatedResultCount", { count: total.count })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.NOT_COUNTED:
      return <span />;
    default:
      total satisfies never;
      return panic("Unhandled search total");
  }
}
