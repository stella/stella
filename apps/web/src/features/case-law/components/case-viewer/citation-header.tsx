import { useQuery } from "@tanstack/react-query";
import { useNow, useTranslations } from "use-intl";

import { CASE_LAW_CITATION_TIMELINE_MAX_YEARS } from "@stll/api-contract";
import { Temporal } from "@stll/time";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import type { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import { VIEWER_OVERLAY_BAR_CLEARANCE } from "@/components/inspector/viewer-overlay-bar";
import { decisionYear, formatYear } from "@/features/case-law/citation-format";
import { totalCitations } from "@/features/case-law/citation-treatment";
import { CitationTimelinePanel } from "@/features/case-law/components/citation-timeline-panel";
import { lastNegativeYear } from "@/features/case-law/components/citation-timeline.logic";
import {
  CITATION_TRIGGER_TOUCH_TARGET,
  CitationYearStrip,
} from "@/features/case-law/components/citation-year-strip";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { useHydrated } from "@/hooks/use-hydrated";
import { useFormatter } from "@/i18n/formatting-context";
import type { SafeId } from "@/lib/safe-id";

type CitationHeaderProps = {
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
  decisionDate,
  decisionId,
  target,
}: CitationHeaderProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow();
  const { data: summary } = useQuery(
    decisionCitationSummaryOptions(decisionId),
  );
  // Prefetched without blocking the route: known on one side of hydration
  // and not the other, so the strip waits for hydration to stay identical.
  const hydrated = useHydrated();

  if (!hydrated || summary === undefined) {
    return null;
  }
  const total = totalCitations(summary.incoming);
  if (total === 0) {
    return null;
  }

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
    t("caseLaw.citation.citedSummary", { count: total }),
    negative > 0
      ? t("caseLaw.citation.negativeCount", { count: negative })
      : null,
    lastNegative === null
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
        "reader-chrome mb-3 flex text-xs print:hidden",
        // The zoom bar floats over this first row at the opposite corner; the
        // row keeps that corner free at every reader width and on every scroll
        // position, since the bar does not move with the text.
        VIEWER_OVERLAY_BAR_CLEARANCE,
      )}
    >
      <Popover>
        <PopoverTrigger
          render={
            <button
              aria-label={summaryText}
              // A 16px strip is a 20px band to tap; the pseudo-element gives
              // a finger the project's 44px target without moving a pixel of
              // what the eye sees.
              className={cn(
                "text-muted-foreground hover:text-foreground flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm px-1 py-0.5 text-start",
                CITATION_TRIGGER_TOUCH_TARGET,
              )}
              type="button"
            />
          }
        >
          <CitationYearStrip
            byYear={summary.incomingByYear}
            fromYear={fromYear}
            toYear={currentYear}
          />
          <span aria-hidden="true">{summaryText}</span>
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
