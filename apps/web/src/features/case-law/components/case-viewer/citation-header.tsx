import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { CASE_LAW_CITATION_TIMELINE_MAX_YEARS } from "@stll/api-contract";

import { totalCitations } from "@/features/case-law/citation-treatment";
import type { CitationYearCounts } from "@/features/case-law/citation-treatment";
import { CitationYearStrip } from "@/features/case-law/components/citation-year-strip";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { useHydrated } from "@/hooks/use-hydrated";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import type { SafeId } from "@/lib/safe-id";

type CitationHeaderProps = {
  decisionDate: Date | string | null;
  decisionId: SafeId<"caseLawDecision">;
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

const lastNegativeYear = (
  byYear: readonly CitationYearCounts[],
): number | null => {
  let last: number | null = null;
  for (const entry of byYear) {
    if (entry.negative > 0 && (last === null || entry.year > last)) {
      last = entry.year;
    }
  }
  return last;
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
}: CitationHeaderProps) => {
  const t = useTranslations();
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

  const decided =
    decisionDate === null ? null : parseDeterministicDate(decisionDate);
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const fromYear = citationStripFromYear({
    currentYear,
    decidedYear: decided === null ? null : decided.getUTCFullYear(),
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
      : t("caseLaw.citation.lastNegative", { year: String(lastNegative) }),
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div
      aria-label={summaryText}
      className="text-muted-foreground mb-3 flex items-center justify-end gap-3 font-sans text-xs print:hidden"
      role="group"
    >
      <CitationYearStrip
        byYear={summary.incomingByYear}
        fromYear={fromYear}
        toYear={currentYear}
      />
      <span aria-hidden="true">{summaryText}</span>
    </div>
  );
};
