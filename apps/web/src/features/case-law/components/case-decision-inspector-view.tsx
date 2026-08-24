import { useRef } from "react";
import type { MouseEvent } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import {
  createCaseDecisionViewTab,
  isPlainPrimaryClick,
} from "@/components/inspector/case-decision-view";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import Tooltip from "@/components/tooltip";
import { CitationHeader } from "@/features/case-law/components/case-viewer/citation-header";
import { DecisionCitations } from "@/features/case-law/components/case-viewer/decision-citations";
import { DecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts";
import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import { ProvisionsCited } from "@/features/case-law/components/case-viewer/provisions-cited";
import { useDecisionCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-citation-anchors";
import { useDecisionProvisionAnchors } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useMainCaseLawDecision } from "@/features/case-law/use-main-decision";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { toSafeId } from "@/lib/safe-id";
import { forceReflow } from "@/lib/utils";

/** A compact decision reader composed for the inspector's bounded width. */
export const CaseDecisionInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<CaseDecisionViewPayload>) => {
  const t = useTranslations();
  const { payload } = tab;
  const decisionId = toSafeId<"caseLawDecision">(payload.decisionId);
  const citationAnchors = useDecisionCitationAnchors(decisionId);
  const provisionAnchors = useDecisionProvisionAnchors(decisionId);
  const {
    data: decision,
    isError,
    isPending,
    refetch,
  } = useQuery(decisionOptions(decisionId));
  const inspector = useInspectorView();
  const mainDecision = useMainCaseLawDecision();
  const mainRef = useRef<HTMLElement>(null);
  // Opened at a passage (a citation of the decision on the main view): once
  // the text is there, go to it and flash it, the way a margin jump does.
  const anchorId = payload.anchorId ?? null;
  const textShown = decision !== undefined;
  useExternalSyncEffect(() => {
    if (anchorId === null || !textShown) {
      return;
    }
    const element = mainRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(anchorId)}`,
    );
    if (!element) {
      return;
    }
    element.scrollIntoView({ block: "center" });
    delete element.dataset["highlight"];
    forceReflow(element);
    element.dataset["highlight"] = "";
  }, [anchorId, textShown]);
  const swapTarget =
    mainDecision !== undefined && mainDecision.id !== payload.decisionId
      ? mainDecision
      : undefined;

  // Plain primary click moves this decision to main; when the main view
  // already shows another decision, the two exchange places instead of
  // the main one being silently dropped. Modified clicks stay native
  // (new browser tab) and leave the inspector untouched.
  const onMainNavigation = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) {
      return;
    }
    onClose();
    if (swapTarget !== undefined) {
      inspector.open(
        createCaseDecisionViewTab({
          caseNumber: swapTarget.caseNumber,
          country: swapTarget.country,
          court: swapTarget.court,
          decisionId: swapTarget.id,
          language: swapTarget.language,
          languageAlternates: swapTarget.languageAlternates,
          slug: swapTarget.slug,
        }),
      );
    }
  };
  const mainLink =
    payload.language === undefined ? (
      <Link
        onClick={onMainNavigation}
        params={{
          country: payload.country,
          court: payload.court,
          slug: payload.slug,
        }}
        to="/law/$country/cases/$court/$slug"
      />
    ) : (
      <Link
        onClick={onMainNavigation}
        params={{
          country: payload.country,
          court: payload.court,
          language: payload.language,
          slug: payload.slug,
        }}
        to="/law/$country/cases/$court/$language/$slug"
      />
    );

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader
        actions={
          <Tooltip
            content={
              swapTarget === undefined
                ? t("chat.moveToMain")
                : t("inspector.swapViews")
            }
            render={
              <Button
                aria-label={
                  swapTarget === undefined
                    ? t("chat.moveToMain")
                    : t("inspector.swapViews")
                }
                render={mainLink}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <Maximize2Icon className="size-3.5" />
          </Tooltip>
        }
        label={tab.label}
        onClose={onClose}
      />
      <ScrollArea className="min-h-0 flex-1">
        <main className="reader-paper min-h-full px-4 py-6" ref={mainRef}>
          <h1 className="sr-only">
            <BidiText as="span">{payload.caseNumber}</BidiText>
          </h1>
          {isPending && <DecisionInspectorLoader />}
          {isError && (
            <div className="flex flex-col items-start gap-2 font-sans">
              <p className="text-muted-foreground text-xs">
                {t("errors.actionFailed")}
              </p>
              <Button
                onClick={() => {
                  detached(refetch(), "case-law.inspector-retry");
                }}
                size="sm"
                variant="ghost"
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
          {decision !== undefined && (
            <>
              <CitationHeader
                decisionDate={decision.decisionDate}
                decisionId={decisionId}
              />
              <DecisionFacts
                decisionType={decision.decisionType}
                metadata={decision.metadata}
                source={decision.source}
                sourceUrl={decision.sourceUrl}
              />
              <DecisionCitations decisionId={decisionId} />
              <ProvisionsCited decisionId={decisionId} />
              <DecisionText
                activeMatchIndex={0}
                citationAnchors={citationAnchors}
                decision={decision}
                provisionAnchors={provisionAnchors}
                searchQuery=""
              />
            </>
          )}
        </main>
      </ScrollArea>
    </div>
  );
};

const DecisionInspectorLoader = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="ms-auto h-3 w-24" />
    <Skeleton className="mx-auto h-5 w-32" />
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-11/12" />
    <Skeleton className="h-3 w-full" />
  </div>
);
