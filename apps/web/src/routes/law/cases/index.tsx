import { useEffect, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";

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
import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@/lib/case-law-route";
import { pageTitle } from "@/lib/page-title";
import {
  createCaseLawCollectionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} from "@/lib/public-law-seo";
import { ensureCriticalQueryData } from "@/lib/react-query";

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
      queryClient.ensureInfiniteQueryData(
        decisionsInfiniteOptions(createDecisionFiltersFromSearch(deps)),
      ),
      ensureCriticalQueryData(queryClient, decisionFacetsOptions()),
    ]);

    return {
      decisions: decisionPages.pages.at(0)?.decisions ?? [],
    };
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
        items:
          loaderData?.decisions.map((decision) => ({
            name: decision.caseNumber,
            url: createPublicLawCanonicalUrl(
              createCaseLawDecisionPath(
                createCaseLawDecisionRouteParams({
                  caseNumber: decision.caseNumber,
                  country: decision.country,
                  court: decision.court,
                  decisionDate: decision.decisionDate,
                  decisionId: decision.id,
                  language: decision.language,
                  languageAlternateCount: decision.languageAlternateCount,
                  slug: decision.slug,
                }),
              ),
            ),
          })) ?? [],
        name: title,
      }),
      path,
      title,
      type: "website",
    });
  },
  component: PublicCaseLawIndex,
});

function PublicCaseLawIndex() {
  const t = useTranslations();
  const search = Route.useSearch({
    select: ({ country, court, year }) => ({ country, court, year }),
  });
  const { country, court, year } = search;
  const routeFilters = createDecisionFiltersFromSearch(search);
  const [filters, setFilters] = useState<DecisionListFilters>(routeFilters);
  const { data: browseFacets } = useSuspenseQuery(decisionFacetsOptions());

  useEffect(() => {
    setFilters(createDecisionFiltersFromSearch({ country, court, year }));
  }, [country, court, year]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      ...decisionsInfiniteOptions(filters),
      placeholderData: keepPreviousData,
    });

  const decisions: Decision[] = [];
  for (const page of data?.pages ?? []) {
    decisions.push(...page.decisions);
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
              void (async () => await fetchNextPage())();
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
              {bucket.count}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
