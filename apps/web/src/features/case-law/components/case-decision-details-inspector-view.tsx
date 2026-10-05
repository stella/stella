import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { DetailsItem } from "@stll/ui/details-grid";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { totalCitations } from "@/features/case-law/citation-treatment";
import { DecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts";
import { DECISION_FACT_KINDS } from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { LeadingCitations } from "@/features/case-law/components/case-viewer/leading-citations";
import { DecisionMainViewAction } from "@/features/case-law/components/decision-main-view-action";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { toSafeId } from "@/lib/safe-id";

/**
 * The facts of a decision, on the inspector's bounded width: the court and
 * the day at the top, the publisher's classification under them, and who
 * cites it and what it cites below. Each block names itself, so a decision
 * nobody cites yet says so instead of ending after five rows.
 */
export const CaseDecisionDetailsInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<CaseDecisionViewPayload>) => {
  const t = useTranslations();
  const format = useFormatter();
  const decisionId = toSafeId<"caseLawDecision">(tab.payload.decisionId);
  const { data: decision, isPending } = useQuery(decisionOptions(decisionId));
  const { data: citationSummary } = useQuery(
    decisionCitationSummaryOptions(decisionId),
  );
  const decided =
    decision?.decisionDate === undefined || decision.decisionDate === null
      ? null
      : parseDeterministicDate(decision.decisionDate);
  const citationCount =
    citationSummary === undefined
      ? null
      : totalCitations(citationSummary.incoming) +
        totalCitations(citationSummary.outgoing);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader
        actions={<DecisionMainViewAction payload={tab.payload} />}
        label={tab.label}
        onClose={onClose}
      />
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
        {/* The pane no longer scrolls sideways, so a value that cannot wrap
            would be clipped instead of read: an ECLI is one unbroken token
            longer than the room this grid leaves it at the 320px minimum.
            `overflow-wrap: anywhere` is inherited, so every value in the view
            (the facts grid below, the citation lists, whatever is added next)
            gets break opportunities from here, and real words still break on
            their own boundaries. */}
        <div className="flex flex-col gap-6 px-4 py-4 font-sans wrap-anywhere">
          {isPending && <DetailsLoader />}
          {decision !== undefined && (
            <>
              {/* The header names the decision; repeating it above the facts
                  would say the same thing twice on a bounded width. */}
              <h1 className="sr-only">
                <BidiText as="span">{tab.payload.caseNumber}</BidiText>
              </h1>
              <Section title={t("common.details")}>
                <DecisionFacts
                  className="mb-0"
                  decisionType={decision.decisionType}
                  facts={DECISION_FACT_KINDS}
                  judges={decision.judges}
                  metadata={decision.metadata}
                  source={decision.source}
                  sourceUrl={decision.sourceUrl}
                >
                  <DetailsItem label={t("common.court")}>
                    {decision.court}
                  </DetailsItem>
                  {decided !== null && (
                    <DetailsItem label={t("common.date")}>
                      {format.dateTime(decided, {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      })}
                    </DetailsItem>
                  )}
                  {decision.ecli !== null && (
                    <DetailsItem label="ECLI" span="wide">
                      <BidiText as="span">{decision.ecli}</BidiText>
                    </DetailsItem>
                  )}
                </DecisionFacts>
              </Section>
              {/* Who cites this decision and what it cites, off the page so
                  the text starts at the top and the lists have room. */}
              <Section
                count={citationCount}
                countCapped={
                  citationSummary?.capped.incoming === true ||
                  citationSummary?.capped.outgoing === true
                }
                title={t("common.citations")}
              >
                {citationCount === 0 &&
                !citationSummary?.capped.incoming &&
                !citationSummary?.capped.outgoing ? (
                  <p className="text-muted-foreground text-xs">
                    {t("caseLaw.citation.none")}
                  </p>
                ) : (
                  <LeadingCitations
                    decision={{
                      caseNumber: decision.caseNumber,
                      caseNumberType: decision.caseNumberType,
                      country: decision.country,
                      court: decision.court,
                      decisionDate: decision.decisionDate,
                      decisionType: decision.decisionType,
                      ecli: decision.ecli,
                      id: decision.id,
                      language: decision.language,
                      languageAlternates: decision.languageAlternates,
                      slug: decision.slug,
                    }}
                    decisionId={decisionId}
                  />
                )}
              </Section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

type SectionProps = {
  children: ReactNode;
  /** How many items the section holds, once known; null while it is not. */
  count?: number | null;
  countCapped?: boolean;
  title: string;
};

/** A titled block of the pane, with its count beside the title once known. */
const Section = ({
  children,
  count,
  countCapped = false,
  title,
}: SectionProps) => {
  const format = useFormatter();

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-foreground-strong-muted flex items-baseline gap-1.5 text-xs font-medium">
        {title}
        {count !== undefined && count !== null && (
          <span className="text-muted-foreground font-normal tabular-nums">
            {format.number(count)}
            {countCapped ? "+" : null}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
};

const DetailsLoader = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-4 w-1/2" />
    <Skeleton className="h-3 w-2/3" />
    <Skeleton className="mt-3 h-3 w-1/3" />
    <Skeleton className="h-3 w-3/4" />
    <Skeleton className="h-3 w-2/3" />
  </div>
);
