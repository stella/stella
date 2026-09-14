import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { COMPOSER_PICKER_TRIGGER_CLASS } from "@stll/ui/composer";
import {
  Popover,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { caseLawCountryName } from "@/features/case-law/components/case-law-search";
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
 * dot and one phrase. Pressing it opens the numbers the phrase stands for:
 * how much of this jurisdiction the corpus holds, and when it last changed.
 * They were a hover tooltip, which a touch reader never sees. The dot is
 * green only while the newest change is inside the window; a stale corpus
 * says when it last changed instead of claiming to be current. Nothing is
 * shown until the status is known; a dot that cannot say when would be a
 * decoration.
 */
export const LawDatabaseStatus = ({ country }: { country: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data: status } = useQuery(caseLawCorpusStatusOptions(country));

  const updatedAt = status?.updatedAt ?? null;
  if (status === undefined || updatedAt === null) {
    return null;
  }
  const upToDate = isWithinLast(updatedAt, UP_TO_DATE_WINDOW_SECONDS);

  return (
    <Popover>
      <PopoverTrigger className={cn(COMPOSER_PICKER_TRIGGER_CLASS, "gap-1.5")}>
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
      </PopoverTrigger>
      <PopoverPanel align="end" side="bottom">
        <PopoverTitle className="text-sm font-medium">
          {caseLawCountryName(format, country)}
        </PopoverTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">{t("common.decisions")}</dt>
          <dd className="text-end tabular-nums">
            {format.number(status.decisions)}
          </dd>
          <dt className="text-muted-foreground">{t("common.lastUpdated")}</dt>
          <dd className="text-end">
            {formatFullTimestamp(updatedAt)}
            <span className="text-muted-foreground block">
              {formatRelativeTime(updatedAt)}
            </span>
          </dd>
        </dl>
      </PopoverPanel>
    </Popover>
  );
};
