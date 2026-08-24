import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { createCaseDecisionDetailsTab } from "@/components/inspector/case-decision-details-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { totalCitations } from "@/features/case-law/citation-treatment";
import { citationStripFromYear } from "@/features/case-law/components/case-viewer/citation-header";
import { CitationYearStrip } from "@/features/case-law/components/citation-year-strip";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { useMainCaseLawDecision } from "@/features/case-law/use-main-decision";
import { useHydrated } from "@/hooks/use-hydrated";
import { useFormatter } from "@/i18n/formatting-context";
import { parseDeterministicDate } from "@/lib/deterministic-date";

/**
 * The reception of the decision on the main view, in the title row: the
 * year strip, how often it is cited, and how the citing courts split for
 * and against. A click opens the details tab, where the citing decisions
 * are listed.
 */
export const TopBarCitations = () => {
  const decision = useMainCaseLawDecision();
  const routeId = useRouterState({
    select: (state) => state.matches.at(-1)?.routeId ?? null,
  });
  if (decision === undefined || routeId === null) {
    return null;
  }
  return <TopBarCitationsFor decision={decision} routeId={routeId} />;
};

const TopBarCitationsFor = ({
  decision,
  routeId,
}: {
  decision: NonNullable<ReturnType<typeof useMainCaseLawDecision>>;
  routeId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
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
  const decided =
    decision.decisionDate === null
      ? null
      : parseDeterministicDate(decision.decisionDate);
  const currentYear = new Date().getUTCFullYear();
  const fromYear = citationStripFromYear({
    currentYear,
    decidedYear: decided === null ? null : decided.getUTCFullYear(),
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
  const openDetails = () => {
    useInspectorTabsStore.getState().openView(
      createCaseDecisionDetailsTab(
        {
          caseNumber: decision.caseNumber,
          country: decision.country,
          court: decision.court,
          decisionId: decision.id,
          language: decision.language,
          languageAlternates: decision.languageAlternates,
          slug: decision.slug,
        },
        routeId,
      ),
    );
  };

  return (
    <button
      aria-label={label}
      className="text-muted-foreground hover:text-foreground ms-auto flex shrink-0 items-center gap-2 rounded-sm px-1 py-0.5 font-sans text-xs transition-colors"
      onClick={openDetails}
      type="button"
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
            <span className="text-destructive">−{format.number(negative)}</span>
          )}
        </span>
      )}
    </button>
  );
};
