import { useMemo, useRef } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { visibleDecisionBlocks } from "@stll/decision-reader/decision-text.logic";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { BookTextIcon, InfoIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { activeLegalFromReaderTarget } from "@/components/ai-suggestions/active-legal-document";
import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorViewRenderProps } from "@/components/inspector/view-registry";
import { AnnotationToolbar } from "@/components/legal-reader/annotations/annotation-toolbar";
import { GuestAnnotationPrompt } from "@/components/legal-reader/annotations/guest-annotation-prompt";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import {
  LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
  LEGAL_READER_LAYOUT_CLASS_NAME,
  LegalReaderControls,
} from "@/components/legal-reader/legal-reader-controls";
import { OpenOriginalButton } from "@/components/legal-reader/open-original-button";
import { useReaderElement } from "@/components/legal-reader/use-reader-element";
import { useWebReaderTextScale as useReaderTextScale } from "@/components/legal-reader/use-web-reader-text-scale";
import { WebDecisionReader as DecisionText } from "@/components/legal-reader/web-decision-reader";
import {
  analysisReaderBreadcrumbPaths,
  decisionInspectorAnnotationTarget,
} from "@/features/case-law/components/case-decision-inspector-view.logic";
import { MarginNotes } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import type { MarginItem } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import { useLazyDecisionAnalysis } from "@/features/case-law/components/case-viewer/analysis/use-lazy-decision-analysis";
import { DecisionCitationBox } from "@/features/case-law/components/case-viewer/decision-citation-box";
import { DecisionFacts } from "@/features/case-law/components/case-viewer/decision-facts";
import {
  buildDecisionFacts,
  hasDecisionFacts,
} from "@/features/case-law/components/case-viewer/decision-facts.logic";
import type {
  DecisionFactKind,
  DecisionFactsInput,
} from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { useDecisionAnnotationSurface } from "@/features/case-law/components/case-viewer/use-decision-annotation-surface";
import { useDecisionCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-citation-anchors";
import { useDecisionProvisionAnchors } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import { useDecisionStatuteCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-statute-citation-anchors";
import { DecisionMainViewAction } from "@/features/case-law/components/decision-main-view-action";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useReaderProvisionMode } from "@/hooks/use-reader-provision-mode";
import { detached } from "@/lib/detached";
import { toSafeId } from "@/lib/safe-id";

/**
 * Every fact the header's info popover carries, so the text is not preceded
 * by a table of them. The source has its own button beside it.
 */
const HEADER_DECISION_FACTS = [
  "decisionType",
  "subject",
  "legalAreas",
  "keywords",
  "judges",
] as const satisfies readonly DecisionFactKind[];

/** A compact decision reader composed for the inspector's bounded width. */
export const CaseDecisionInspectorView = ({
  onClose,
  tab,
}: InspectorViewRenderProps<CaseDecisionViewPayload>) => {
  const t = useTranslations();
  const { payload } = tab;
  const textScale = useReaderTextScale();
  const provisions = useReaderProvisionMode();
  const decisionId = toSafeId<"caseLawDecision">(payload.decisionId);
  const citationAnchors = useDecisionCitationAnchors(decisionId);
  const {
    data: decision,
    isError,
    isPending,
    refetch,
  } = useQuery(decisionOptions(decisionId));
  const decisionDate = decision?.decisionDate ?? null;
  const ast = parseDocumentAst(decision?.documentAst);
  const analysis = useLazyDecisionAnalysis({
    decisionId,
    decisionUpdatedAt: decision?.updatedAt ?? "",
    documentReady: ast !== null,
    sourceAllowsDerivedAi: decision?.source.allowsDerivedAi === true,
    mode: "enabled",
  });
  const analysisTree =
    analysis.state.status === "done" ? analysis.state.analysis.tree : null;
  // The observer binds to model identity; unrelated inspector renders must not
  // reset its active path while the completed analysis is unchanged.
  const fallbackBreadcrumb = useMemo(
    () =>
      analysisTree === null
        ? undefined
        : analysisReaderBreadcrumbPaths(analysisTree),
    [analysisTree],
  );
  // No text is shown before the decision loads, so the default is moot then.
  const caseNumberType =
    decision?.caseNumberType ?? DECISION_IDENTIFIER_TYPES.CASE_NUMBER;
  const provisionAnchors = useDecisionProvisionAnchors({
    court: decision?.court ?? null,
    caseNumber: decision?.caseNumber ?? null,
    surface: "inspector",
    blocks: visibleDecisionBlocks(ast, caseNumberType, decision?.fulltext),
    country: decision?.country ?? null,
    decisionId,
    decisionDate,
  });
  const statuteCitationAnchors = useDecisionStatuteCitationAnchors(
    visibleDecisionBlocks(ast, caseNumberType, decision?.fulltext),
    decisionDate,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  const {
    readerRef: contentRef,
    element: contentElement,
    attach: attachContent,
  } = useReaderElement<HTMLElement>();
  const { element: viewportElement, attach: attachViewport } =
    useReaderElement<HTMLDivElement>();
  // Cmd/Ctrl+F belongs to the decision in front of the reader rather than to
  // the results table behind it, for as long as there is text to search.
  const find = useInspectorFind({
    contentRef,
    enabled: decision !== undefined,
    highlightKey: tab.id,
    initialQuery: payload.searchQuery,
    panelRef,
  });
  // The same marks, store and bar the full page has. The target is addressed
  // by the tab's own decision id, so the reader's marks are already the right
  // ones before the decision itself has arrived.
  const annotationTarget = decisionInspectorAnnotationTarget({
    ast,
    decision,
    decisionId,
    payload,
  });
  const annotations = useDecisionAnnotationSurface({
    marks: "all",
    scrollContainerRef: contentRef,
    target: annotationTarget,
  });
  // The pane has no margin column, so a note takes its place in the text:
  // under the paragraph it belongs to, where the margin would have put it
  // beside.
  const notesByAnchorId = ((): ReadonlyMap<string, ReactNode> => {
    const grouped = new Map<string, MarginItem[]>();
    for (const note of annotations.notes) {
      const items = grouped.get(note.startAnchorId);
      if (items === undefined) {
        grouped.set(note.startAnchorId, [note]);
        continue;
      }
      items.push(note);
    }
    const rendered = new Map<string, ReactNode>();
    for (const [anchorId, items] of grouped) {
      rendered.set(anchorId, <MarginNotes items={items} placement="inline" />);
    }
    return rendered;
  })();
  return (
    <div
      // The pane is resizable down to 320px and nothing inside it may widen
      // it: `min-w-0` lets this column shrink past its content's intrinsic
      // width, and the clip is the backstop for a child that still refuses.
      // A child that needs the room wraps or truncates; it never scrolls the
      // pane sideways.
      className={cn(
        LEGAL_READER_LAYOUT_CLASS_NAME,
        "bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip overflow-y-hidden",
      )}
      ref={panelRef}
    >
      <InspectorTabHeader
        actions={
          <>
            {decision !== undefined && (
              <>
                <Button
                  aria-label={t("caseLaw.reader.expandProvisions")}
                  aria-pressed={provisions.expandProvisions}
                  data-pressed={provisions.expandProvisions ? "" : undefined}
                  onClick={provisions.toggle}
                  size="icon-xs"
                  tooltip={t("caseLaw.reader.expandProvisions")}
                  variant="ghost"
                >
                  <BookTextIcon aria-hidden="true" className="size-3.5" />
                </Button>
                <OpenOriginalButton href={decision.sourceUrl} size="icon-xs" />
                <DecisionInfoPopover
                  decisionType={decision.decisionType}
                  judges={decision.judges}
                  metadata={decision.metadata}
                  source={decision.source}
                  sourceUrl={decision.sourceUrl}
                />
              </>
            )}
            {/* The text moves to the page, so the tab that held it goes. */}
            <DecisionMainViewAction
              onMoveToMain={onClose}
              payload={{ ...payload, searchQuery: find.findQuery || undefined }}
            />
          </>
        }
        label={tab.label}
        onClose={onClose}
      />
      <InspectorFindBar find={find} />
      <GuestAnnotationPrompt
        className="shrink-0"
        count={annotations.guestCount}
      />
      {/* The composer floats over the text, bound to this decision, the way
          it floats over a PDF bound to that file. */}
      <LegalReaderAIChat
        aiMode={analysis.available ? "enabled" : "gated"}
        activeLegal={activeLegalFromReaderTarget(annotationTarget)}
        className="min-h-0 flex-1"
      >
        {/* The pane's width is the reader's to drag; nothing the court's file
            contains may take it. A table that needs the axis scrolls inside
            its own box. */}
        <ScrollArea
          axis="vertical"
          className="h-full"
          viewportRef={attachViewport}
        >
          <main
            className={cn(
              "reader-paper min-h-full px-4 pb-6",
              LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
            )}
            ref={attachContent}
            {...textScale.rootProps}
          >
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
                <DecisionCitationBox
                  decision={{
                    caseNumber: decision.caseNumber,
                    caseNumberType: decision.caseNumberType,
                    country: decision.country,
                    court: decision.court,
                    courtAbbreviation: decision.courtAbbreviation,
                    sourceUrl: decision.sourceUrl,
                    decisionDate: decision.decisionDate,
                    decisionType: decision.decisionType,
                    ecli: decision.ecli,
                    id: decision.id,
                    language: decision.language,
                    languageAlternates: decision.languageAlternates,
                    slug: decision.slug,
                  }}
                  decisionDate={decision.decisionDate}
                  decisionId={decisionId}
                />
                {/* The find bar owns every search mark; the landing passage
                    remains independent of the query the reader edits. */}
                <DecisionText
                  surface="inspector"
                  annotationAnchors={annotations.anchors}
                  citationAnchors={citationAnchors}
                  decision={decision}
                  decisionId={decisionId}
                  expandProvisions={provisions.expandProvisions}
                  landingAnchorId={payload.anchorId}
                  notesByAnchorId={notesByAnchorId}
                  onAnnotationActivate={annotations.setActiveAnnotationId}
                  provisionAnchors={provisionAnchors}
                  statuteCitationAnchors={statuteCitationAnchors}
                />
              </>
            )}
          </main>
        </ScrollArea>
        {/* The same bar the PDF floats over its page, over the text. */}
        <LegalReaderControls
          blocks={ast === null ? [] : ast.blocks}
          content={contentElement}
          fallbackBreadcrumb={fallbackBreadcrumb}
          viewport={viewportElement}
          textScale={textScale}
          key={decisionId}
        />
      </LegalReaderAIChat>
      <AnnotationToolbar
        activeAnnotation={annotations.activeAnnotation}
        activeSpans={annotations.activeSpans}
        controller={annotations.controller}
        mode={annotations.mode}
        onActivateAnnotation={annotations.setActiveAnnotationId}
        onClearActive={annotations.clearActive}
        onCompose={annotations.startComposing}
        scrollContainerRef={contentRef}
        target={annotationTarget}
      />
    </div>
  );
};

/**
 * The publisher's classification of the decision, one press away. It labels
 * the text rather than being part of it, and at this width a two-row table
 * above the first paragraph costs more than it tells.
 */
const DecisionInfoPopover = (input: DecisionFactsInput) => {
  const t = useTranslations();
  const facts = buildDecisionFacts(input);
  if (!hasDecisionFacts({ facts, kinds: HEADER_DECISION_FACTS })) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("common.details")}
            size="icon-xs"
            title={t("common.details")}
            variant="ghost"
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-72" side="bottom">
        <DecisionFacts
          {...input}
          className="mb-0"
          facts={HEADER_DECISION_FACTS}
        />
      </PopoverPopup>
    </Popover>
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
