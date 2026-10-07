import { useTranslations } from "use-intl";

import type { LegislationExpressionEligibility } from "@stll/api-contract/legislation-expression";
import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";

import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
  type StatuteDisplayStatus,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";
import { formatValidityRange } from "@/lib/statute-format";

const STATUS_TONE = {
  current: "success",
  draft: "warning",
  future: "neutral",
  historical: "warning",
  repealed: "warning",
} as const satisfies Record<StatuteDisplayStatus, ReviewStatusTone>;

const STATUS_DOT_CLASS = {
  current: undefined,
  draft: undefined,
  future: "bg-info",
  historical: undefined,
  repealed: undefined,
} as const satisfies Record<StatuteDisplayStatus, string | undefined>;

type StatuteValidityIndicatorProps = {
  expression: LegislationExpressionEligibility;
  status: string;
  validFrom: string | null;
  validTo: string | null;
};

/**
 * One status signal shared by the reader header and version history. A
 * version that cannot apply is never drawn in an in-force colour, whatever
 * its stored status; `expression` is null where the surface does not know.
 */
export const StatuteStatusDot = ({
  expression,
  status,
  validFrom,
}: {
  expression: LegislationExpressionEligibility | null;
  status: string;
  validFrom: string | null;
}) => {
  const displayStatus = resolveStatuteDisplayStatus({ status, validFrom });

  if (
    expression === null ||
    ineligibleExpressionLabelKey(expression) !== null
  ) {
    return <ReviewStatusDot tone="neutral" />;
  }

  return (
    <ReviewStatusDot
      className={cn(
        displayStatus === null ? undefined : STATUS_DOT_CLASS[displayStatus],
      )}
      tone={displayStatus === null ? "warning" : STATUS_TONE[displayStatus]}
    />
  );
};

/**
 * Current-or-old signal and the exact validity window, shared by readers. A
 * version that cannot apply is named for what it is, and its window reads as
 * the dates its publisher stated.
 */
export const StatuteValidityIndicator = ({
  expression,
  status,
  validFrom,
  validTo,
}: StatuteValidityIndicatorProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const displayStatus = resolveStatuteDisplayStatus({ status, validFrom });
  const ineligibleLabel = ineligibleExpressionLabelKey(expression);
  const range = formatValidityRange({
    format,
    openEnded: t("statutes.openEnded"),
    validFrom,
    validTo,
  });
  const lifecycleLabel =
    displayStatus === null
      ? status
      : t(STATUTE_STATUS_LABEL_KEYS[displayStatus]);
  const statusLabel =
    ineligibleLabel === null ? lifecycleLabel : t(ineligibleLabel);

  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <StatuteStatusDot
        expression={expression}
        status={status}
        validFrom={validFrom}
      />
      <span className="text-foreground font-medium">{statusLabel}</span>
      <span>
        {ineligibleLabel === null
          ? range
          : t("statutes.statedWindow", { range })}
      </span>
    </div>
  );
};
