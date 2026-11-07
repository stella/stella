import { useQuery } from "@tanstack/react-query";
import { useNow, useTranslations } from "use-intl";

import { CASE_LAW_CITATION_TIMELINE_MAX_YEARS } from "@stll/api-contract";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import type { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import { decisionYear, formatYear } from "@/features/case-law/citation-format";
import {
  citationSummaryIsCapped,
  hasIncomingCitations,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import { CitationTimelinePanel } from "@/features/case-law/components/citation-timeline-panel";
import { lastNegativeYear } from "@/features/case-law/components/citation-timeline.logic";
import {
  CITATION_TRIGGER_TOUCH_TARGET,
  CitationYearStrip,
} from "@/features/case-law/components/citation-year-strip";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { useHydrated } from "@/hooks/use-hydrated";
import { useFormatter } from "@/i18n/formatting-context";
import { queryView } from "@/lib/query-view.logic";
import type { SafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";

type CitationHeaderProps = {
  /** The compact inspector shows counts beside the chart in its own row. */
  compact?: boolean;
  decisionDate: string | null;
  decisionId: SafeId<"caseLawDecision">;
  /** The decision, as the citing-decisions tab the panel opens needs it. */
  target: Parameters<typeof createCaseDecisionDetailsTab>[0];
};

type CitationStripFromYearOptions = {
  currentYear: number;
  decidedYear: number | null;
  firstCitedYear: number | null;
};

/**
 * First column of the strip: the decision's year or its first citing year,
 * whichever is earlier, but never before the span the summary covers. An
 * old decision otherwise draws a column for every year back to its date.
 */
export const citationStripFromYear = ({
  currentYear,
  decidedYear,
  firstCitedYear,
}: CitationStripFromYearOptions): number => {
  const spanStart = currentYear - (CASE_LAW_CITATION_TIMELINE_MAX_YEARS - 1);
  const earliest = Math.min(
    decidedYear ?? currentYear,
    firstCitedYear ?? currentYear,
  );
  return Math.max(spanStart, earliest);
};

/**
 * The decision's reception at a glance: citations per year since it was
 * decided, and the one figure a reader must not miss, negative treatment.
 *
 * Absent until the summary is known and absent for an uncited decision: a
 * flat strip would only say "nothing", which the missing panel already says.
 */
export const CitationHeader = ({
  compact = false,
  decisionDate,
  decisionId,
  target,
}: CitationHeaderProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow();
  const summaryQuery = useQuery(decisionCitationSummaryOptions(decisionId));
  const summaryView = queryView(summaryQuery);
  useQueryViewError(summaryView, "CitationHeader:query");
  const summary = summaryView.type === "items" ? summaryView.items : undefined;
  // Prefetched without blocking the route: known on one side of hydration
  // and not the other, so the strip waits for hydration to stay identical.
  const hydrated = useHydrated();

  if (!hydrated || summary === undefined) {
    return null;
  }
  if (!hasIncomingCitations(summary)) {
    return null;
  }
  const total = totalCitations(summary.incoming);

  const currentYear = Temporal.Instant.fromEpochMilliseconds(
    now.getTime(),
  ).toZonedDateTimeISO("UTC").year;
  const fromYear = citationStripFromYear({
    currentYear,
    decidedYear: decisionYear(decisionDate),
    firstCitedYear: summary.incomingByYear.at(0)?.year ?? null,
  });
  const negative = summary.incoming.negative;
  const lastNegative = lastNegativeYear(summary.incomingByYear);

  const summaryText = [
    citationSummaryIsCapped(summary, "incoming")
      ? t("caseLaw.citation.citedAtLeast", { count: format.number(total) })
      : t("caseLaw.citation.citedSummary", { count: total }),
    !citationSummaryIsCapped(summary, "incoming") && negative > 0
      ? t("caseLaw.citation.negativeCount", { count: negative })
      : null,
    citationSummaryIsCapped(summary, "incoming") || lastNegative === null
      ? null
      : t("caseLaw.citation.lastNegative", {
          year: formatYear(format, lastNegative),
        }),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div
      className={cn(
        "reader-chrome flex text-xs print:hidden",
        compact ? "justify-center" : "mb-3",
      )}
    >
      <Popover>
        <PopoverTrigger
          render={
            // The strip draws the trigger, so the button paints nothing of
            // its own. A 16px strip is a 20px band to tap; the touch target
            // gives a finger the project's 44px without moving a pixel of
            // what the eye sees.
            <Button
              aria-label={summaryText}
              className="group/plain"
              variant="plain"
            />
          }
        >
          <span
            className={cn(
              "text-muted-foreground group-hover/plain:text-foreground group-data-popup-open/plain:text-foreground flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-1 py-0.5",
              CITATION_TRIGGER_TOUCH_TARGET,
            )}
          >
            <CitationYearStrip
              byYear={summary.incomingByYear}
              fromYear={fromYear}
              toYear={currentYear}
            />
            {!compact && <span aria-hidden="true">{summaryText}</span>}
          </span>
        </PopoverTrigger>
        <PopoverPanel
          align="start"
          className="w-[min(24rem,calc(100vw-2rem))] max-w-none"
        >
          <CitationTimelinePanel
            fromYear={fromYear}
            summary={summary}
            target={target}
            toYear={currentYear}
          />
        </PopoverPanel>
      </Popover>
    </div>
  );
};
