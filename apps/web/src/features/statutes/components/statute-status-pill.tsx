import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import {
  isStatuteStatus,
  STATUTE_STATUS_LABEL_KEYS,
  type StatuteStatus,
} from "@/features/statutes/statute-status";

const STATUS_CLASS = {
  current: "bg-success/15 text-success",
  draft: "bg-muted text-muted-foreground",
  historical: "bg-muted text-muted-foreground",
  repealed: "bg-destructive/12 text-destructive",
} as const satisfies Record<StatuteStatus, string>;

/**
 * Lifecycle badge for one statute version. An unknown value is shown
 * verbatim: the corpus constrains the column, so it can only appear when
 * that constraint and this list have drifted apart.
 */
export const StatuteStatusPill = ({ status }: { status: string }) => {
  const t = useTranslations();

  if (!isStatuteStatus(status)) {
    return (
      <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
        {status}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        STATUS_CLASS[status],
      )}
    >
      {t(STATUTE_STATUS_LABEL_KEYS[status])}
    </span>
  );
};
