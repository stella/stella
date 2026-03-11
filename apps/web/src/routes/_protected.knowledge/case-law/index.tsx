import { useMemo, useState } from "react";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import { DecisionFilters } from "@/routes/_protected.knowledge/case-law/-components/decision-filters";
import { DecisionTable } from "@/routes/_protected.knowledge/case-law/-components/decision-table";
import type { Decision } from "@/routes/_protected.knowledge/case-law/-components/decision-table";
import { decisionsInfiniteOptions } from "@/routes/_protected.knowledge/case-law/-queries/decisions";
import type {
  DecisionListFilters,
  SearchFacets,
} from "@/routes/_protected.knowledge/case-law/-queries/decisions";

export const Route = createFileRoute("/_protected/knowledge/case-law/")({
  component: CaseLawIndex,
});

function CaseLawIndex() {
  const t = useTranslations();
  const [filters, setFilters] = useState<DecisionListFilters>({});

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      ...decisionsInfiniteOptions(filters),
      placeholderData: keepPreviousData,
    });

  // SAFETY: Both list and search branches return the same
  // Decision shape. TS can't unify Eden-inferred and
  // hand-mapped types across the union.
  const decisions = useMemo(
    () => (data?.pages.flatMap((page) => page.decisions) ?? []) as Decision[],
    [data],
  );

  // SAFETY: facets shape matches SearchFacets; TS can't unify
  // Eden-inferred type across the search/list union.
  const facets = useMemo(
    () => (data?.pages.at(0)?.facets ?? null) as SearchFacets,
    [data],
  );

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("caseLaw.title")}</h1>
      </div>

      <DecisionFilters
        facets={facets}
        filters={filters}
        onFiltersChange={setFilters}
      />

      <DecisionTable decisions={decisions} isLoading={isLoading} />

      {hasNextPage && (
        <div className="flex justify-center py-4">
          <Button
            disabled={isFetchingNextPage}
            // eslint-disable-next-line typescript/no-misused-promises
            onClick={() => fetchNextPage()}
            variant="outline"
          >
            {isFetchingNextPage
              ? t("caseLaw.loadingMore")
              : t("caseLaw.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
