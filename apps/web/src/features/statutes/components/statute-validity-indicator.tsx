import { useTranslations } from "use-intl";

import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";

import { formatValidityRange } from "@/features/statutes/statute-format";
import {
  resolveStatuteDisplayStatus,
  STATUTE_STATUS_LABEL_KEYS,
  type StatuteDisplayStatus,
} from "@/features/statutes/statute-status";
import { useFormatter } from "@/i18n/formatting-context";

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
  status: string;
  validFrom: string | null;
  validTo: string | null;
};

/** One status signal shared by the reader header and version history. */
export const StatuteStatusDot = ({
  status,
  validFrom,
}: {
  status: string;
  validFrom: string | null;
}) => {
  const displayStatus = resolveStatuteDisplayStatus({ status, validFrom });

  return (
    <ReviewStatusDot
      className={cn(
        displayStatus === null ? undefined : STATUS_DOT_CLASS[displayStatus],
      )}
      tone={displayStatus === null ? "warning" : STATUS_TONE[displayStatus]}
    />
  );
};

/** Current-or-old signal and the exact validity window, shared by readers. */
export const StatuteValidityIndicator = ({
  status,
  validFrom,
  validTo,
}: StatuteValidityIndicatorProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const displayStatus = resolveStatuteDisplayStatus({ status, validFrom });
  const statusLabel =
    displayStatus === null
      ? status
      : t(STATUTE_STATUS_LABEL_KEYS[displayStatus]);

  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <StatuteStatusDot status={status} validFrom={validFrom} />
      <span className="text-foreground font-medium">{statusLabel}</span>
      <span>
        {formatValidityRange({
          format,
          openEnded: t("statutes.openEnded"),
          validFrom,
          validTo,
        })}
      </span>
    </div>
  );
};
