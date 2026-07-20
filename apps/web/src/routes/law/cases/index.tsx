import { useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { DecisionFilters } from "@/features/case-law/components/decision-filters";
import { DecisionTable } from "@/features/case-law/components/decision-table";
import type { Decision } from "@/features/case-law/components/decision-table";
import {
  decisionFacetsOptions,
  decisionsInfiniteOptions,
} from "@/features/case-law/queries/decisions";
import type {
  CaseLawBrowseFacets,
  DecisionListFilters,
  SearchFacets,
} from "@/features/case-law/queries/decisions";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { pageTitle } from "@/lib/page-title";
import {
  createCaseLawCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";

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
  year: optionalBrowseStringSchema(4),
});

type CaseLawIndexSearch = v.InferOutput<typeof searchSchema>;

const createDecisionFiltersFromSearch = ({
  country,
  court,
  year,
}: CaseLawIndexSearch): DecisionListFilters => {
  const normalizedYear = /^\d{4}$/u.test(year ?? "") ? year : undefined;

  return {
    ...(country ? { country: country.toUpperCase() } : {}),
    ...(court ? { court } : {}),
    ...(normalizedYear
      ? {
          dateFrom: `${normalizedYear}-01-01`,
          dateTo: `${normalizedYear}-12-31`,
        }
      : {}),
  };
};

const createCaseLawIndexPath = ({
  country,
  court,
  year,
}: CaseLawIndexSearch): `/law/cases${string}` => {
  const params = new URLSearchParams();
  const normalizedYear = /^\d{4}$/u.test(year ?? "") ? year : undefined;
  if (country) {
    params.set("country", country.toLowerCase());
  }
  if (court) {
    params.set("court", court);
  }
  if (normalizedYear) {
    params.set("year", normalizedYear);
  }

  const query = params.toString();
  return query ? `/law/cases?${query}` : "/law/cases";
};

const createCaseLawIndexDescription = ({
  country,
  court,
  year,
}: CaseLawIndexSearch): string => {
  const scope = [
    court,
    country?.toUpperCase(),
    /^\d{4}$/u.test(year ?? "") ? year : null,
  ]
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
  loader: async ({ context: { queryClient }, deps }) => {
    const [decisionPages] = await Promise.all([
      ensureRouteInfiniteQueryData(
        queryClient,
        decisionsInfiniteOptions(createDecisionFiltersFromSearch(deps)),
      ),
      ensureRouteQueryData(queryClient, decisionFacetsOptions()),
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
      jsonLd: createCaseLawCollectionJsonLd({
        canonicalUrl: createPublicLawCanonicalUrl(path),
        description,
        items: loaderData
          ? loaderData.decisions.map((decision) => ({
              name: decision.caseNumber,
              url: createPublicLawCanonicalUrl(
                createCaseLawDecisionPath(
                  createCaseLawDecisionRouteParams({
                    caseNumber: decision.caseNumber,
                    country: decision.country,
                    court: decision.court,
                    language: decision.language,
                    languageAlternateCount: decision.languageAlternateCount,
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

// The loader fetches decisions + facets (both delayed by slow-load), so without
// a pendingComponent the route flashes the glowing logo. Reuse the real
// DecisionTable skeleton plus the page chrome during route-pending.
function PublicCaseLawIndexPending() {
  const t = useTranslations();
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("common.caseLaw")}</h1>
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-40 rounded-md" />
        <Skeleton className="h-9 w-32 rounded-md" />
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
      <DecisionTable decisions={[]} isLoading />
    </main>
  );
}

function PublicCaseLawIndex() {
  const t = useTranslations();
  const search = Route.useSearch({
    select: ({ country, court, year }) => ({ country, court, year }),
  });
  const { country, court, year } = search;
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
      "PublicCaseLawIndex",
    );
  }, [notFound, navigate, t]);
  const routeFilters = createDecisionFiltersFromSearch(search);
  const [filters, setFilters] = useState<DecisionListFilters>(routeFilters);
  const { data: browseFacets } = useSuspenseQuery(decisionFacetsOptions());

  // Resync filters when the route search params change. Adjust state during
  // render (the React-sanctioned pattern) instead of an effect so there is no
  // extra commit/paint cycle.
  const [prevSearch, setPrevSearch] = useState({ country, court, year });
  if (
    prevSearch.country !== country ||
    prevSearch.court !== court ||
    prevSearch.year !== year
  ) {
    setPrevSearch({ country, court, year });
    setFilters(createDecisionFiltersFromSearch({ country, court, year }));
  }

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

  const facets: SearchFacets = data?.pages.at(0)?.facets ?? null;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("common.caseLaw")}</h1>
      </div>

      <DecisionFilters
        facets={facets}
        filters={filters}
        onFiltersChange={setFilters}
      />

      <CaseLawBrowseLinks facets={browseFacets} />

      <DecisionTable decisions={decisions} isLoading={isLoading} />

      {hasNextPage && (
        <div className="flex justify-center py-4">
          <Button
            disabled={isFetchingNextPage}
            onClick={() => {
              detached(
                (async () => await fetchNextPage())(),
                "PublicCaseLawIndex",
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
    </main>
  );
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
