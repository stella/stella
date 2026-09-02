import { useCallback, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import {
  CASE_LAW_ALL_COUNTRIES,
  defaultCaseLawCountryForLocale,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { CaseLawBrowseLinks } from "@/features/case-law/components/case-law-browse-links";
import { CaseLawSearch } from "@/features/case-law/components/case-law-search";
import {
  DecisionFilterChips,
  type DecisionFilterSelection,
} from "@/features/case-law/components/decision-filter-chips";
import {
  DecisionColumnChooser,
  DecisionTable,
} from "@/features/case-law/components/decision-table";
import type { Decision } from "@/features/case-law/components/decision-table";
import {
  type DecisionQueryIntent,
  exactDecisionMatches,
} from "@/features/case-law/decision-query-intent";
import {
  caseLawCountryScope,
  createDecisionFiltersFromSearch,
  openDecisionMatch,
  readDecisionIntent,
  validDecisionYear,
} from "@/features/case-law/open-decision-match";
import {
  decisionFacetsOptions,
  decisionsInfiniteOptions,
} from "@/features/case-law/queries/decisions";
import type { CaseLawBrowseFacets } from "@/features/case-law/queries/decisions";
import { ResearchTableActions } from "@/features/case-law/research/research-actions";
import { useLocale } from "@/i18n/formatting-context";
import { getMessageLocale } from "@/i18n/i18n-store";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
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

/** Facet chips before any facet answer has arrived. */
const NO_FACET_BUCKETS: CaseLawBrowseFacets["court"] = [];

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
  q: optionalBrowseStringSchema(MAX_QUERY_LENGTH),
  year: optionalBrowseStringSchema(4),
});

type CaseLawIndexSearch = v.InferOutput<typeof searchSchema>;

const createCaseLawIndexPath = ({
  country,
  court,
  q,
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
  if (q) {
    params.set("q", q);
  }

  const query = params.toString();
  return query ? `/law/cases?${query}` : "/law/cases";
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
  // page and its links agree on the scope; readers in other languages, and
  // crawlers, start unscoped. Both are server-side redirects because this is
  // a public SSR path: the throw becomes a real HTTP redirect for crawlers
  // and no-JS clients. The blank-page race that no-beforeload-redirect guards
  // against is specific to the client-only _protected subtree.
  beforeLoad: ({ search }) => {
    const localeDefault = defaultCaseLawCountryForLocale(getMessageLocale());
    const country =
      search.country ??
      (localeDefault === null
        ? undefined
        : toCaseLawCountryParam(localeDefault));

    if (
      search.q === undefined &&
      search.court === undefined &&
      search.year === undefined
    ) {
      throw redirect({ to: "/law", search: { country }, replace: true });
    }

    if (search.country === undefined && country !== undefined) {
      throw redirect({
        to: "/law/cases",
        search: { ...search, country },
        replace: true,
      });
    }
  },
  loader: async ({ context: { queryClient }, deps }) => {
    const scope = caseLawCountryScope(deps.country);
    const [decisionPages] = await Promise.all([
      ensureRouteInfiniteQueryData(
        queryClient,
        decisionsInfiniteOptions(createDecisionFiltersFromSearch(deps)),
      ),
      // Unscoped for the pill's countries; scoped for the chips.
      ensureRouteQueryData(queryClient, decisionFacetsOptions()),
      scope === undefined
        ? Promise.resolve()
        : ensureRouteQueryData(queryClient, decisionFacetsOptions(scope)),
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
// route flashes the glowing logo. Reuse the real table skeleton plus the page
// chrome during route-pending.
function PublicCaseLawIndexPending() {
  const t = useTranslations();
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("common.caseLaw")}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-40 rounded-md" />
        <Skeleton className="h-9 w-full max-w-md flex-1 rounded-md" />
      </div>
      <Skeleton className="h-4 w-40" />
      <DecisionTable
        decisions={[]}
        hiddenColumnIds={[]}
        isLoading
        order="newest"
      />
    </main>
  );
}

function PublicCaseLawIndex() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const uiLocale = useLocale();
  const search = Route.useSearch({
    select: ({ country, court, q, year }) => ({ country, court, q, year }),
  });
  const navigate = Route.useNavigate();
  const routerNavigate = useNavigate();

  const countryParam = search.country ?? CASE_LAW_ALL_COUNTRIES;
  const scope = caseLawCountryScope(search.country);
  const intent = readDecisionIntent(search.q);
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
  const handleQueryChange = useCallback(
    (value: string) => {
      setQueryInput(value);
      setRequestedQuery(value.trim());
      writeQuery(value);
    },
    [writeQuery],
  );
  // Resync the field when the route query changes underneath it. Adjust state
  // during render (the React-sanctioned pattern) instead of an effect.
  const [syncedQuery, setSyncedQuery] = useState(search.q);
  if (syncedQuery !== search.q) {
    setSyncedQuery(search.q);
    if ((search.q ?? "") !== requestedQuery) {
      setQueryInput(search.q ?? "");
    }
  }

  const [hiddenColumnIds, setHiddenColumnIds] = useState<string[]>([]);

  const { data: allFacets } = useSuspenseQuery(decisionFacetsOptions());
  const { data: scopedFacets } = useQuery({
    ...decisionFacetsOptions(scope),
    enabled: scope !== undefined,
  });
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

  const searchFacets = data?.pages.at(0)?.facets ?? null;
  const browseFacets: CaseLawBrowseFacets | undefined =
    scope === undefined ? allFacets : scopedFacets;
  const courtBuckets =
    searchFacets?.court ?? browseFacets?.court ?? NO_FACET_BUCKETS;
  const yearBuckets = browseFacets?.year ?? NO_FACET_BUCKETS;

  const selection: DecisionFilterSelection = {
    court: search.court,
    year: validDecisionYear(search.year),
  };
  const setSelection = (next: DecisionFilterSelection) => {
    // A pending debounced query write would otherwise land after this
    // navigation and re-apply the old field value to the new filters.
    writeQuery.cancel();
    detached(
      navigate({
        replace: true,
        search: (previous) => ({
          ...previous,
          court: next.court,
          year: next.year,
        }),
      }),
      "cases.filter-navigate",
    );
  };

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

  const order = intent.type === "empty" ? "newest" : "relevance";

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("common.caseLaw")}</h1>
        <ResearchTableActions filters={filters} />
      </div>

      <CaseLawSearch
        countries={allFacets.country.map((bucket) => bucket.value)}
        country={countryParam}
        maxLength={MAX_QUERY_LENGTH}
        onCountryChange={(country) => {
          writeQuery.cancel();
          detached(
            navigate({
              replace: true,
              search: (previous) => ({
                ...previous,
                country,
                court: undefined,
                year: undefined,
              }),
            }),
            "cases.switch-country",
          );
        }}
        onQueryChange={handleQueryChange}
        onSubmit={openSingleMatch}
        query={queryInput}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ListHeading exactCount={exact.length} intent={intent} />
        <div className="flex flex-wrap items-center gap-2">
          <DecisionFilterChips
            courts={courtBuckets}
            onSelectionChange={setSelection}
            selection={selection}
            years={yearBuckets}
          />
          <DecisionColumnChooser
            hiddenColumnIds={hiddenColumnIds}
            onHiddenColumnIdsChange={setHiddenColumnIds}
          />
        </div>
      </div>

      <DecisionTable
        decisions={ordered}
        hiddenColumnIds={hiddenColumnIds}
        isLoading={isLoading}
        order={order}
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

      <CaseLawBrowseLinks facets={allFacets} />
    </main>
  );
}

/**
 * What the list under the box is: newest first while a filter alone narrows
 * it, a choice between courts when a docket names several decisions, nothing
 * for a plain search.
 */
function ListHeading({
  exactCount,
  intent,
}: {
  exactCount: number;
  intent: DecisionQueryIntent;
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
      <p className="text-muted-foreground text-xs">
        {t("caseLaw.sameCaseNumber", { count: exactCount })}
      </p>
    );
  }
  return <span />;
}
