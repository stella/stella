import { useInfiniteQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { PROVISION_CITING_FILTER_LIMITS } from "@stll/api-contract/provision-citing-decisions";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";

import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import { decisionCitationPresentationsById } from "@/components/references/decision-citation-presentation.logic";
import { CitingDecisionItem } from "@/features/statutes/components/citing-decision-item";
import { citingDecisionsInfiniteOptions } from "@/features/statutes/queries/citing-decisions";
import { readProvisionCitingSearch } from "@/features/statutes/statute-page-search";
import type { ProvisionCitingSearch } from "@/features/statutes/statute-page-search";
import { useFormatter } from "@/i18n/formatting-context";
import type { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import type { PublicLawData } from "@/lib/public-law-api";

export { CitingDecisionItem } from "@/features/statutes/components/citing-decision-item";
export type CitingDecisionRow = PublicLawData<
  (typeof api.case.provisions)["citing-decisions"]["get"]
>["items"][number];

type ProvisionCitingDecisionsProps = {
  anchorId: string;
  eli: string;
  jurisdiction: string;
  currentVersionValidFrom: string | null;
  filters: ProvisionCitingSearch;
  onFiltersChange: (filters: ProvisionCitingSearch) => void;
};

export const ProvisionCitingDecisions = ({
  anchorId,
  eli,
  jurisdiction,
  currentVersionValidFrom,
  filters,
  onFiltersChange,
}: ProvisionCitingDecisionsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery(
    citingDecisionsInfiniteOptions(
      { anchor: anchorId, eli, jurisdiction },
      filters,
    ),
  );
  const byDecision = new Map<string, CitingDecisionRow>();
  for (const page of optionalArray(data?.pages)) {
    for (const decision of page.items) {
      byDecision.set(decision.decisionId, decision);
    }
  }
  const decisions = [...byDecision.values()];
  const presentations = decisionCitationPresentationsById(
    decisions.map((decision) => ({
      decisionId: decision.decisionId,
      courtShortCode: decisionCitationCourtLabel(decision),
    })),
  );
  const snapshot = data?.pages.at(0)?.snapshot;
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        key={JSON.stringify(filters)}
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const court = fields.get("court");
          const year = fields.get("year");
          onFiltersChange(
            readProvisionCitingSearch({
              citingCourt:
                typeof court === "string" && court.trim() !== ""
                  ? court
                  : undefined,
              citingYear:
                typeof year === "string" && year !== ""
                  ? Number(year)
                  : undefined,
              citingSort: filters.citingSort,
            }),
          );
        }}
      >
        <Input
          aria-label={t("caseLaw.filters.court")}
          className="min-w-24 flex-1"
          size="sm"
          defaultValue={filters.citingCourt ?? ""}
          maxLength={PROVISION_CITING_FILTER_LIMITS.courtChars}
          name="court"
          placeholder={t("statutes.citingDecisionsCourtPlaceholder")}
          type="search"
        />
        <Input
          aria-label={t("statutes.citingDecisionsYear")}
          className="w-24"
          size="sm"
          defaultValue={filters.citingYear ?? ""}
          max={PROVISION_CITING_FILTER_LIMITS.yearMax}
          min={PROVISION_CITING_FILTER_LIMITS.yearMin}
          name="year"
          placeholder={t("statutes.citingDecisionsYearPlaceholder")}
          step={1}
          type="number"
        />
        <Button size="sm" type="submit" variant="ghost">
          {t("common.filter")}
        </Button>
        <Select
          onValueChange={(value) => {
            if (value !== null) {
              onFiltersChange({ ...filters, citingSort: value });
            }
          }}
          value={filters.citingSort}
        >
          <SelectTrigger aria-label={t("common.sort")} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">
              {t("statutes.citingDecisionsSortDate")}
            </SelectItem>
            <SelectItem value="citations">
              {t("statutes.citingDecisionsSortCitations")}
            </SelectItem>
          </SelectContent>
        </Select>
      </form>
      {snapshot?.type === "capped" && (
        <p className="text-muted-foreground text-xs">
          {t("statutes.citingDecisionsSnapshotCapped", {
            count: format.number(decisions.length),
            limit: format.number(snapshot.limit),
          })}
        </p>
      )}
      {isPending && <CitingDecisionsLoader />}
      {isError && (
        <div className="flex flex-col items-start gap-1" role="alert">
          <p className="text-muted-foreground text-xs">
            {t("errors.actionFailed")}
          </p>
          <Button
            onClick={() =>
              detached(refetch(), "statutes.citing-decisions-retry")
            }
            size="sm"
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {!isPending && !isError && decisions.length === 0 && (
        <p className="text-muted-foreground text-xs">{t("common.noResults")}</p>
      )}
      {!isPending && !isError && decisions.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {decisions.map((decision) => (
            <li key={decision.decisionId}>
              <CitingDecisionItem
                currentVersionValidFrom={currentVersionValidFrom}
                decision={decision}
                presentation={
                  presentations.get(decision.decisionId) ??
                  panic("Citing decision missing collected identity")
                }
              />
            </li>
          ))}
        </ul>
      )}
      {hasNextPage && (
        <Button
          disabled={isFetchingNextPage}
          onClick={() =>
            detached(fetchNextPage(), "statutes.citing-decisions-more")
          }
          size="sm"
          variant="ghost"
        >
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};

const CitingDecisionsLoader = () => (
  <div aria-busy="true" className="flex flex-col gap-2">
    {[0, 1, 2].map((row) => (
      <Skeleton className="h-12 w-full" key={row} />
    ))}
  </div>
);
