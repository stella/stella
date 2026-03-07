import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import { DecisionFilters } from "@/routes/_protected.knowledge/case-law/-components/decision-filters";
import {
  DecisionTable,
  type Decision,
} from "@/routes/_protected.knowledge/case-law/-components/decision-table";
import {
  decisionsInfiniteOptions,
  type DecisionListFilters,
} from "@/routes/_protected.knowledge/case-law/-queries/decisions";

export const Route = createFileRoute("/_protected/knowledge/case-law/")({
  component: CaseLawIndex,
});

function CaseLawIndex() {
  const t = useTranslations();
  const [filters, setFilters] = useState<DecisionListFilters>({});

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery(decisionsInfiniteOptions(filters));

  // SAFETY: Both list and search branches return the same
  // Decision shape. TS can't unify Eden-inferred and
  // hand-mapped types across the union.
  const decisions = useMemo(
    () => (data?.pages.flatMap((page) => page.decisions) ?? []) as Decision[],
    [data],
  );

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("caseLaw.title")}</h1>
      </div>

      <DecisionFilters filters={filters} onFiltersChange={setFilters} />

      <DecisionTable decisions={decisions} isLoading={isLoading} />

      {hasNextPage && (
        <div className="flex justify-center py-4">
          <Button
            disabled={isFetchingNextPage}
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
