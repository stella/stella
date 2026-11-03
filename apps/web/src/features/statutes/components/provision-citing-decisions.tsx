import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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

import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { CitingDecisionItem } from "@/features/statutes/components/citing-decision-item";
import { orderCitingDecisions } from "@/features/statutes/components/provision-citing-decisions.logic";
import {
  citingDecisionsInfiniteOptions,
  topCitingDecisionsOptions,
} from "@/features/statutes/queries/citing-decisions";
import { readProvisionCitingSearch } from "@/features/statutes/statute-page-search";
import type { ProvisionCitingSearch } from "@/features/statutes/statute-page-search";
import { useFormatter } from "@/i18n/formatting-context";
import type { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import type { PublicLawData } from "@/lib/public-law-api";

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

/**
 * Every decision citing the provision, as one list: the leading decisions
 * first and marked as leading, then the rest in the order the reader picked.
 * The two reads settle together, so a leading decision never jumps from the
 * list's body to its head under the reader's eyes.
 */
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
  const leadingQuery = useQuery(
    topCitingDecisionsOptions({ anchor: anchorId, eli, jurisdiction }),
  );
  // A court or year narrows the list to what matches; the leading read was
  // not narrowed, so its decisions keep their mark but not the list's head.
  const pinLeading =
    filters.citingCourt === undefined && filters.citingYear === undefined;
  const loaded = optionalArray(data?.pages).flatMap((page) => page.items);
  const decisions = orderCitingDecisions({
    leading: optionalArray(leadingQuery.data),
    pinLeading,
    rest: loaded,
  });
  const listPending = isPending || (pinLeading && leadingQuery.isPending);
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
          aria-label={t("common.court")}
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
            count: format.number(
              new Set(loaded.map((decision) => decision.decisionId)).size,
            ),
            limit: format.number(snapshot.limit),
          })}
        </p>
      )}
      {listPending && <CitingDecisionsLoader />}
      {isError && (
        <ReadRetry
          onRetry={() => detached(refetch(), "statutes.citing-decisions-retry")}
        />
      )}
      {/* Without the leading read the list still stands; it only loses its
          head until the retry brings it back. */}
      {leadingQuery.isError && (
        <ReadRetry
          onRetry={() =>
            detached(leadingQuery.refetch(), "statutes.leading-decisions-retry")
          }
        />
      )}
      {!listPending && !isError && decisions.length === 0 && (
        <p className="text-muted-foreground text-xs">{t("common.noResults")}</p>
      )}
      {!listPending && !isError && decisions.length > 0 && (
        <ul className="divide-border/60 m-0 flex list-none flex-col divide-y p-0">
          {decisions.map(({ decision, leading }) => (
            <li key={decision.decisionId}>
              <CitingDecisionItem
                currentVersionValidFrom={currentVersionValidFrom}
                decision={decision}
                leading={leading}
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

const ReadRetry = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations();
  return (
    <RecoverableErrorStatus
      className="flex flex-col items-start gap-1"
      message={t("errors.actionFailed")}
      messageClassName="text-muted-foreground text-xs"
      actions={
        <Button onClick={onRetry} size="sm" variant="ghost">
          {t("common.retry")}
        </Button>
      }
    />
  );
};

const CitingDecisionsLoader = () => (
  <div aria-busy="true" className="flex flex-col gap-2">
    {[0, 1, 2].map((row) => (
      <Skeleton className="h-12 w-full" key={row} />
    ))}
  </div>
);
