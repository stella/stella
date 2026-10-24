import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { DecisionQueryIntent } from "@stll/api-contract/decision-query-intent";
import { SEARCH_TOTAL_TYPE, type SearchTotal } from "@stll/api-contract/search";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";

type CaseLawResultsSummaryProps = {
  exactCount: number;
  intent: DecisionQueryIntent;
  /** The count still answers the previous search; say so without hiding it. */
  isRefreshing: boolean;
  page: number;
  relaxedHitCount: number | undefined;
  total: SearchTotal;
};

export const CaseLawResultsSummary = ({
  isRefreshing,
  ...summary
}: CaseLawResultsSummaryProps) => (
  <div
    aria-busy={isRefreshing}
    className={cn(
      "transition-opacity duration-200",
      isRefreshing && "opacity-56",
    )}
  >
    <CaseLawResultsSummaryText {...summary} />
  </div>
);

const CaseLawResultsSummaryText = ({
  exactCount,
  intent,
  page,
  relaxedHitCount = 0,
  total,
}: Omit<CaseLawResultsSummaryProps, "isRefreshing">) => {
  const t = useTranslations();
  const format = useFormatter();

  if (intent.type === "empty") {
    return (
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {page > 1
          ? t("common.page", { page: format.number(page) })
          : t("caseLaw.newestDecisions")}
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
  if (relaxedHitCount > 0) {
    if (total.type === SEARCH_TOTAL_TYPE.NOT_COUNTED) {
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.pageWithPartialMatchCount", {
            page: format.number(page),
            relaxedCount: relaxedHitCount,
          })}
        </p>
      );
    }
    if (total.type === SEARCH_TOTAL_TYPE.ESTIMATE) {
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.pageWithEstimatedMatchCounts", {
            exactCount: total.count,
            page: format.number(page),
            relaxedCount: relaxedHitCount,
          })}
        </p>
      );
    }
    return (
      <p className="text-xs tabular-nums">
        {t("caseLaw.pagination.pageWithMatchCounts", {
          exactCount: total.count,
          page: format.number(page),
          relaxedCount: relaxedHitCount,
        })}
      </p>
    );
  }
  switch (total.type) {
    case SEARCH_TOTAL_TYPE.EXACT:
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.pageWithResultCount", {
            count: total.count,
            page: format.number(page),
          })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.ESTIMATE:
      return (
        <p className="text-xs tabular-nums">
          {t("caseLaw.pagination.pageWithEstimatedResultCount", {
            count: total.count,
            page: format.number(page),
          })}
        </p>
      );
    case SEARCH_TOTAL_TYPE.NOT_COUNTED:
      return (
        <p className="text-xs tabular-nums">
          {t("common.page", { page: format.number(page) })}
        </p>
      );
    default:
      total satisfies never;
      return panic("Unhandled search total");
  }
};
