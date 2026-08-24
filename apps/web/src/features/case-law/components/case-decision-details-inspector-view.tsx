import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { CitationHeader } from "@/features/case-law/components/case-viewer/citation-header";
import { DecisionCitations } from "@/features/case-law/components/case-viewer/decision-citations";
import { DecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { toSafeId } from "@/lib/safe-id";

/** The facts of a decision, on the inspector's bounded width. */
export const CaseDecisionDetailsInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<CaseDecisionViewPayload>) => {
  const t = useTranslations();
  const format = useFormatter();
  const decisionId = toSafeId<"caseLawDecision">(tab.payload.decisionId);
  const { data: decision, isPending } = useQuery(decisionOptions(decisionId));
  const decided =
    decision?.decisionDate === undefined || decision.decisionDate === null
      ? null
      : parseDeterministicDate(decision.decisionDate);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader label={t("common.details")} onClose={onClose} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 py-4 font-sans">
          <h2 className="text-foreground mb-4 text-sm font-medium">
            <BidiText as="span">{tab.payload.caseNumber}</BidiText>
          </h2>
          {isPending && <DetailsLoader />}
          {decision !== undefined && (
            <>
              <dl className="text-muted-foreground mb-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
                <Row label={t("caseLaw.columns.court")}>{decision.court}</Row>
                {decided !== null && (
                  <Row label={t("common.date")}>
                    {format.dateTime(decided, {
                      dateStyle: "medium",
                      timeZone: "UTC",
                    })}
                  </Row>
                )}
                {decision.ecli !== null && (
                  <Row label="ECLI">
                    <BidiText as="span">{decision.ecli}</BidiText>
                  </Row>
                )}
              </dl>
              <DecisionFacts
                decisionType={decision.decisionType}
                metadata={decision.metadata}
                source={decision.source}
                sourceUrl={decision.sourceUrl}
              />
              {/* Who cites this decision and what it cites, off the page
                  so the text starts at the top and the lists have room. */}
              <div className="mt-6">
                <CitationHeader
                  decisionDate={decision.decisionDate}
                  decisionId={decisionId}
                />
                <DecisionCitations decisionId={decisionId} />
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

const Row = ({ children, label }: { children: ReactNode; label: string }) => (
  <>
    <dt className="text-foreground-disabled font-medium tracking-wide uppercase">
      {label}
    </dt>
    <dd className="text-foreground-strong-muted min-w-0">{children}</dd>
  </>
);

const DetailsLoader = () => (
  <div className="flex flex-col gap-3">
    <Skeleton className="h-3 w-2/3" />
    <Skeleton className="h-3 w-1/2" />
    <Skeleton className="h-3 w-3/4" />
  </div>
);
