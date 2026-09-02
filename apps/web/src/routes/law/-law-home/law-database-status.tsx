import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { caseLawCorpusStatusOptions } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import {
  formatFullTimestamp,
  formatRelativeTime,
  isWithinLast,
} from "@/lib/relative-time";

/**
 * How recent the newest change may be for the corpus to count as current:
 * the courts publish daily and ingestion follows within the day, so a week
 * of silence is a stalled feed, not a quiet week.
 */
const UP_TO_DATE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * The corpus's freshness, where the chat's status row keeps its meter: a
 * dot and one phrase, with the count and the exact timestamp on hover. The
 * dot is green only while the newest change is inside the window; a stale
 * corpus says when it last changed instead of claiming to be current.
 * Nothing is shown until the status is known; a dot that cannot say when
 * would be a decoration.
 */
export const LawDatabaseStatus = () => {
  const t = useTranslations();
  const format = useFormatter();
  const { data: status } = useQuery(caseLawCorpusStatusOptions());

  const updatedAt = status?.updatedAt ?? null;
  if (status === undefined || updatedAt === null) {
    return null;
  }
  const upToDate = isWithinLast(updatedAt, UP_TO_DATE_WINDOW_SECONDS);

  return (
    <Tooltip
      content={t("lawHome.databaseStatus", {
        count: format.number(status.decisions),
        date: formatFullTimestamp(updatedAt),
      })}
      render={
        <span className="inline-flex cursor-default items-center gap-1.5 text-[11px]" />
      }
      side="top"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          upToDate ? "bg-success" : "bg-foreground-muted",
        )}
      />
      {upToDate
        ? t("lawHome.databaseUpToDate")
        : t("caseLaw.research.updated", {
            date: formatRelativeTime(updatedAt),
          })}
    </Tooltip>
  );
};
