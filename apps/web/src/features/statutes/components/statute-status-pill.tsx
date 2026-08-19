import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

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
 * Lifecycle badge for one statute version. The label map is total over the
 * lifecycle contract the database CHECK is built from, so a new status fails
 * to compile here before it can reach a reader; the verbatim fallback covers
 * only a value that reached the column without passing that constraint.
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
