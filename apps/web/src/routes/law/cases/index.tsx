import { useCallback, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import {
  CASE_LAW_ALL_COUNTRIES,
  defaultCaseLawCountryForLocale,
  fromCaseLawCountryParam,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
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
import { LatestDecisionsShelf } from "@/features/case-law/components/latest-decisions-shelf";
import {
  type DecisionQueryIntent,
  exactDecisionMatches,
  parseDecisionQuery,
} from "@/features/case-law/decision-query-intent";
import {
  decisionFacetsOptions,
  decisionsInfiniteOptions,
  latestDecisionsOptions,
} from "@/features/case-law/queries/decisions";
import type {
  CaseLawBrowseFacets,
  DecisionListFilters,
} from "@/features/case-law/queries/decisions";
import { ResearchTableActions } from "@/features/case-law/research/research-actions";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { getMessageLocale } from "@/i18n/i18n-store";
import { pickPreferredCaseLawLanguageVariant } from "@/lib/case-law-language-preference";
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
  notFound: v.optional(v.boolean()),
  q: optionalBrowseStringSchema(MAX_QUERY_LENGTH),
  year: optionalBrowseStringSchema(4),
});

type CaseLawIndexSearch = v.InferOutput<typeof searchSchema>;

const validYear = (year: string | undefined): string | undefined =>
  /^\d{4}$/u.test(year ?? "") ? year : undefined;

/**
 * The corpus country the pill names: none for `all`, else the code. A URL
 * without a country is scoped by `beforeLoad` before this is ever read.
 */
const countryScope = (country: string | undefined): string | undefined =>
  country === undefined || country === CASE_LAW_ALL_COUNTRIES
    ? undefined
    : fromCaseLawCountryParam(country);

const readIntent = (q: string | undefined): DecisionQueryIntent =>
  q === undefined ? { type: "empty" } : parseDecisionQuery(q);

const createDecisionFiltersFromSearch = ({
  country,
  court,
  q,
  year,
}: CaseLawIndexSearch): DecisionListFilters => {
  const scope = countryScope(country);
  const normalizedYear = validYear(year);
  const intent = readIntent(q);

  return {
    ...(scope === undefined ? {} : { country: scope }),
    ...(court ? { court } : {}),
    ...(normalizedYear
      ? {
          dateFrom: `${normalizedYear}-01-01`,
          dateTo: `${normalizedYear}-12-31`,
        }
      : {}),
    ...(intent.type === "identifier" ? { search: intent.value } : {}),
    ...(intent.type === "text" ? { search: intent.text } : {}),
  };
};

const createCaseLawIndexPath = ({
  country,
  court,
  q,
  year,
}: CaseLawIndexSearch): `/law/cases${string}` => {
  const params = new URLSearchParams();
  const normalizedYear = validYear(year);
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
  const scope = [court, countryScope(country), validYear(year)]
    .filter(Boolean)
    .join(", ");
  if (scope) {
    return `Public case-law database for ${scope}, with indexable court decisions and legal source materials.`;
  }

  return "Public case-law database with indexable court decisions and legal source materials.";
};

/** The shelf shows for a scoped, query-less page: nothing typed, one jurisdiction. */
const shelfCountry = (search: CaseLawIndexSearch): string | undefined =>
  search.q === undefined &&
  search.court === undefined &&
  search.year === undefined
    ? countryScope(search.country)
    : undefined;

export const Route = createFileRoute("/law/cases/")({
  validateSearch: searchSchema,
  // A first visit starts in the jurisdiction the UI language points at, and
  // the URL says so, so the page and its links agree on the scope. Readers in
  // other languages, and crawlers, start unscoped. A server-side redirect for
  // the same reason `/law` uses one: this is a public SSR path.
  loaderDeps: ({ search }) => search,
  beforeLoad: ({ search }) => {
    if (search.country !== undefined) {
      return;
    }
    const country = defaultCaseLawCountryForLocale(getMessageLocale());
    if (country === null) {
      return;
    }
    throw redirect({
      to: "/law/cases",
      search: { ...search, country: toCaseLawCountryParam(country) },
      replace: true,
    });
  },
  loader: async ({ context: { queryClient }, deps }) => {
    const scope = countryScope(deps.country);
    const shelf = shelfCountry(deps);
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
      shelf === undefined
        ? Promise.resolve()
        : ensureRouteQueryData(queryClient, latestDecisionsOptions(shelf)),
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

// The loader fetches decisions, facets and the shelf, so without a
// pendingComponent the route flashes the glowing logo. Reuse the real table
// skeleton plus the page chrome during route-pending.
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
  const notFound = Route.useSearch({ select: (s) => s.notFound });
  const navigate = Route.useNavigate();

  useExternalSyncEffect(() => {
    if (!notFound) {
      return;
    }
    stellaToast.add({
      title: t("caseLaw.decisionNotFound"),
      type: "error",
    });
    detached(
      navigate({
        replace: true,
        search: (prev) => ({ ...prev, notFound: undefined }),
      }),
      "cases.navigate",
    );
  }, [notFound, navigate, t]);

  const countryParam = search.country ?? CASE_LAW_ALL_COUNTRIES;
  const scope = countryScope(search.country);
  const intent = readIntent(search.q);
  const filters = createDecisionFiltersFromSearch(search);
  const shelf = shelfCountry(search);

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
  const { data: latest } = useQuery({
    ...latestDecisionsOptions(shelf ?? ""),
    enabled: shelf !== undefined,
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
    year: validYear(search.year),
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
    const submitted = readIntent(queryInput.trim() || undefined);
    if (submitted.type !== "identifier") {
      return;
    }
    writeQuery.flush();
    detached(
      (async () => {
        const pages = await ensureRouteInfiniteQueryData(
          queryClient,
          decisionsInfiniteOptions(
            createDecisionFiltersFromSearch({ ...search, q: submitted.value }),
          ),
        );
        // Only a result set the page has seen whole can prove the match is
        // the only one: with more pages unseen, another court's decision
        // under the same docket may still be coming, so the list stays and
        // the reader picks.
        const firstPage = pages.pages.at(0);
        if (firstPage === undefined || firstPage.nextCursor !== null) {
          return;
        }
        const matches = exactDecisionMatches(
          submitted.value,
          firstPage.decisions,
        );
        const only = matches.length === 1 ? matches.at(0) : undefined;
        if (only === undefined) {
          return;
        }
        const preferred = pickPreferredCaseLawLanguageVariant({
          alternates: only.languageAlternates,
          matchedLanguage: only.language,
          uiLocale,
        });
        const target =
          preferred === null
            ? {
                caseNumber: only.caseNumber,
                country: only.country,
                court: only.court,
                decisionId: only.id,
                language: only.language,
                slug: only.slug,
              }
            : {
                caseNumber: preferred.caseNumber,
                country: preferred.country,
                court: preferred.court,
                decisionId: preferred.id,
                language: preferred.language,
                slug: preferred.slug,
              };
        const params = createCaseLawDecisionRouteParams({
          ...target,
          languageAlternates: only.languageAlternates,
        });
        await (params.language === undefined
          ? navigate({
              params: {
                country: params.country,
                court: params.court,
                slug: params.slug,
              },
              to: "/law/$country/cases/$court/$slug",
            })
          : navigate({
              params: {
                country: params.country,
                court: params.court,
                language: params.language,
                slug: params.slug,
              },
              to: "/law/$country/cases/$court/$language/$slug",
            }));
      })(),
      "cases.open-match",
    );
  };

  const showShelf = shelf !== undefined && latest !== undefined;
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
          {!showShelf && (
            <DecisionFilterChips
              courts={courtBuckets}
              onSelectionChange={setSelection}
              selection={selection}
              years={yearBuckets}
            />
          )}
          <DecisionColumnChooser
            hiddenColumnIds={hiddenColumnIds}
            onHiddenColumnIdsChange={setHiddenColumnIds}
          />
        </div>
      </div>

      {showShelf && latest.courts.length > 0 ? (
        <LatestDecisionsShelf
          countryParam={countryParam}
          courts={latest.courts}
          hiddenColumnIds={hiddenColumnIds}
        />
      ) : (
        <>
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
        </>
      )}

      <CaseLawBrowseLinks facets={allFacets} />
    </main>
  );
}

/**
 * What the list under the box is: the recency shelf when nothing was typed,
 * a choice between courts when a docket names several decisions, nothing
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

function CaseLawBrowseLinks({ facets }: { facets: CaseLawBrowseFacets }) {
  const t = useTranslations();

  if (
    facets.country.length === 0 &&
    facets.court.length === 0 &&
    facets.year.length === 0
  ) {
    return null;
  }

  return (
    <nav
      aria-label={t("caseLaw.seo.browse")}
      className="border-border/45 bg-background/60 grid gap-4 border-y py-4 text-sm md:grid-cols-3"
    >
      <BrowseGroup
        buckets={facets.country}
        createSearch={(value) => ({ country: value.toLowerCase() })}
        title={t("caseLaw.seo.countries")}
      />
      <BrowseGroup
        buckets={facets.court}
        createSearch={(value) => ({ court: value })}
        title={t("caseLaw.seo.courts")}
      />
      <BrowseGroup
        buckets={facets.year}
        createSearch={(value) => ({ year: value })}
        title={t("caseLaw.seo.years")}
      />
    </nav>
  );
}

function BrowseGroup({
  buckets,
  createSearch,
  title,
}: {
  buckets: readonly { count: number; value: string }[];
  createSearch: (value: string) => CaseLawIndexSearch;
  title: string;
}) {
  const format = useFormatter();
  if (buckets.length === 0) {
    return null;
  }

  return (
    <section className="min-w-0">
      <h2 className="text-foreground mb-2 text-sm font-medium">{title}</h2>
      <ul className="space-y-1">
        {buckets.map((bucket) => (
          <li className="flex min-w-0 items-baseline gap-2" key={bucket.value}>
            <Link
              className="text-primary min-w-0 truncate hover:underline"
              search={createSearch(bucket.value)}
              to="/law/cases"
            >
              {bucket.value}
            </Link>
            <span className="text-muted-foreground shrink-0 text-xs">
              {format.number(bucket.count)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
