import { useQuery } from "@tanstack/react-query";
import { useNow, useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { decisionYear } from "@/features/case-law/citation-format";
import { totalCitations } from "@/features/case-law/citation-treatment";
import { citationStripFromYear } from "@/features/case-law/components/case-viewer/citation-header";
import { CitationTimelinePanel } from "@/features/case-law/components/citation-timeline-panel";
import {
  CITATION_TRIGGER_TOUCH_TARGET,
  CitationYearStrip,
} from "@/features/case-law/components/citation-year-strip";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { useMainCaseLawDecision } from "@/features/case-law/use-main-decision";
import { useHydrated } from "@/hooks/use-hydrated";
import { useFormatter } from "@/i18n/formatting-context";

/**
 * The reception of the decision on the main view, in the title row: the
 * year strip, how often it is cited, and how the citing courts split for
 * and against. A click opens the timeline, and the citing decisions are one
 * step further.
 */
export const TopBarCitations = () => {
  const decision = useMainCaseLawDecision();
  if (decision === undefined) {
    return null;
  }
  return <TopBarCitationsFor decision={decision} />;
};

const TopBarCitationsFor = ({
  decision,
}: {
  decision: PublicCaseLawDecision;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const now = useNow();
  const { data: summary } = useQuery(
    decisionCitationSummaryOptions(decision.id),
  );
  // Prefetched without blocking the route: known on one side of hydration
  // and not the other, so the row waits for hydration to stay identical.
  const hydrated = useHydrated();
  if (!hydrated || summary === undefined) {
    return null;
  }
  const total = totalCitations(summary.incoming);
  if (total === 0) {
    return null;
  }
  const positive = summary.incoming.positive + summary.incoming.supportive;
  const negative = summary.incoming.negative;
  const currentYear = Temporal.Instant.fromEpochMilliseconds(
    now.getTime(),
  ).toZonedDateTimeISO("UTC").year;
  const fromYear = citationStripFromYear({
    currentYear,
    decidedYear: decisionYear(decision.decisionDate),
    firstCitedYear: summary.incomingByYear.at(0)?.year ?? null,
  });
  const label = [
    t("caseLaw.citation.citedSummary", { count: total }),
    positive > 0
      ? t("caseLaw.citation.positiveCount", { count: positive })
      : null,
    negative > 0
      ? t("caseLaw.citation.negativeCount", { count: negative })
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const target = {
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionId: decision.id,
    language: decision.language,
    languageAlternates: decision.languageAlternates,
    slug: decision.slug,
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label={label}
            className={cn(
              "text-muted-foreground hover:text-foreground ms-3 flex shrink-0 items-center gap-2 rounded-sm px-1 py-0.5 font-sans text-xs",
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
        <span aria-hidden="true" className="tabular-nums">
          {format.number(total)}
        </span>
        {(positive > 0 || negative > 0) && (
          <span
            aria-hidden="true"
            className="flex items-center gap-1 tabular-nums"
          >
            {positive > 0 && (
              <span className="text-primary">+{format.number(positive)}</span>
            )}
            {negative > 0 && (
              <span className="text-destructive">
                −{format.number(negative)}
              </span>
            )}
          </span>
        )}
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
  );
};
