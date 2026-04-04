import { useMemo, useState } from "react";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import { DecisionFilters } from "@/routes/_protected.knowledge/case/-components/decision-filters";
import { DecisionTable } from "@/routes/_protected.knowledge/case/-components/decision-table";
import type { Decision } from "@/routes/_protected.knowledge/case/-components/decision-table";
import { decisionsInfiniteOptions } from "@/routes/_protected.knowledge/case/-queries/decisions";
import type {
  DecisionListFilters,
  SearchFacets,
} from "@/routes/_protected.knowledge/case/-queries/decisions";

export const Route = createFileRoute("/_protected/knowledge/case/")({
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

  // SAFETY: Both list and search branches return the same Decision shape.
  const decisions = useMemo(
    () =>
      // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      (data?.pages.flatMap((page) => page.decisions) ?? []) as Decision[],
    [data],
  );

  // SAFETY: facets shape matches SearchFacets across the union.
  const facets = useMemo(
    () =>
      // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
      (data?.pages.at(0)?.facets ?? null) as SearchFacets,
    [data],
  );

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("common.caseLaw")}</h1>
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
            onClick={async () => await fetchNextPage()}
            variant="outline"
          >
            {isFetchingNextPage
              ? t("caseLaw.loadingMore")
              : t("common.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
