import { useCallback, useRef, useState } from "react";

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { formatDecisionParagraphRange } from "@stll/api-contract/decision-paragraph-range";
import type { ReaderAnswerSpans } from "@stll/api-contract/reader-answers";
import type { DecisionDocumentState } from "@stll/decision-reader/decision-body-state.logic";
import { prepareDecisionProvisionCards } from "@stll/decision-reader/decision-text";
import { decisionCaseName } from "@stll/decision-reader/decision-text.logic";
import { ReaderAiLabel } from "@stll/decision-reader/reader-ai-label";
import {
  readerSelectionMatches,
  visibleDecisionBlocks,
  visibleReaderAnchorPiecesOf,
} from "@stll/legal-ast/case-law-reader";
import {
  type DocumentAst,
  parseDocumentAst,
} from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ScrollTextIcon, SparklesIcon, UserRoundIcon } from "@stll/ui/icons";
import { InspectorRailIconButton } from "@stll/ui/inspector";
import { Loader } from "@stll/ui/loader";
import { MatterIcon } from "@stll/ui/matter-icon";
import { OutlineRail } from "@stll/ui/outline-rail";
import type { OutlineItem } from "@stll/ui/outline-rail";
import { Separator } from "@stll/ui/separator";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { activeLegalFromReaderTarget } from "@/components/ai-suggestions/active-legal-document";
import {
  createCaseDecisionViewTab,
  navigateToCaseDecisionMain,
} from "@/components/inspector/case-decision-view";
import { AnnotationToolbar } from "@/components/legal-reader/annotations/annotation-toolbar";
import { GuestAnnotationPrompt } from "@/components/legal-reader/annotations/guest-annotation-prompt";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import {
  LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
  LEGAL_READER_LAYOUT_CLASS_NAME,
  LegalReaderControls,
} from "@/components/legal-reader/legal-reader-controls";
import { MarginNotes } from "@/components/legal-reader/margin-notes";
import type {
  AnalysisMarginItem,
  AnswerMarginItem,
  ProvisionMarginItem,
} from "@/components/legal-reader/margin-notes";
import { READER_BREADCRUMB_CLEARANCE } from "@/components/legal-reader/reader-breadcrumb-scroll";
import { useReaderElement } from "@/components/legal-reader/use-reader-element";
import { useWebReaderTextScale } from "@/components/legal-reader/use-web-reader-text-scale";
import { WebDecisionReader as DecisionText } from "@/components/legal-reader/web-decision-reader";
import { WebReaderProvider } from "@/components/legal-reader/web-reader-provider";
import Tooltip from "@/components/tooltip";
import { hasIncomingCitations } from "@/features/case-law/citation-treatment";
import {
  AiHeadnotes,
  hasAiHeadnotes,
} from "@/features/case-law/components/case-viewer/analysis/ai-headnotes";
import { AnalysisErrorNotice } from "@/features/case-law/components/case-viewer/analysis/analysis-error-notice";
import { AnalysisLayers } from "@/features/case-law/components/case-viewer/analysis/analysis-layers";
import { CurrentSection } from "@/features/case-law/components/case-viewer/analysis/current-section";
import {
  EXAMPLE_NOTES,
  exampleNoteAnchors,
} from "@/features/case-law/components/case-viewer/analysis/example-notes.logic";
import { useAnalysisReaderBreadcrumb } from "@/features/case-law/components/case-viewer/analysis/reader-breadcrumb";
import {
  buildSectionMap,
  flattenAnalysisHeadings,
  getCategoryVar,
  getHeadingDisplayAnchorId,
} from "@/features/case-law/components/case-viewer/analysis/types";
import { useLazyDecisionAnalysis } from "@/features/case-law/components/case-viewer/analysis/use-lazy-decision-analysis";
import type { ReaderMarksFilter } from "@/features/case-law/components/case-viewer/decision-annotation-surface.logic";
import { annotationsForMarksFilter } from "@/features/case-law/components/case-viewer/decision-annotation-surface.logic";
import { useDecisionParagraphLanding } from "@/features/case-law/components/case-viewer/decision-paragraph-landing";
import { decisionParagraphLanding } from "@/features/case-law/components/case-viewer/decision-paragraph-landing.logic";
import {
  clickOpensVisitorOffer,
  NOTES_FILTER_SHOWS_AI,
  READER_ASIDE_RESIZE_SLOT,
  resolveVisitorOffer,
} from "@/features/case-law/components/case-viewer/decision-workspace.logic";
import type { NotesFilter } from "@/features/case-law/components/case-viewer/decision-workspace.logic";
import { paragraphRangeIndices } from "@/features/case-law/components/case-viewer/paragraph-reference.logic";
import { useDecisionAnnotationSurface } from "@/features/case-law/components/case-viewer/use-decision-annotation-surface";
import { useDecisionCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-citation-anchors";
import { useDecisionProvisionAnchors } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import { useDecisionStatuteCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-statute-citation-anchors";
import { ReaderProvisionModeToggle } from "@/features/case-law/components/reader-provision-mode-toggle";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useReaderProvisionMode } from "@/hooks/use-reader-provision-mode";
import { useFormatter } from "@/i18n/formatting-context";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { ChromeHeaderActions } from "@/lib/chrome-header-actions";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { detachedUserAction, notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import type { SafeId } from "@/lib/safe-id";
import { useQueryView } from "@/lib/use-query-view";
import { forceReflow } from "@/lib/utils";

import { useUnresolvedCitationTelemetry } from "./paragraph-citation-telemetry";
import {
  citedDecisionRead,
  resolveReaderAnswerCitation,
} from "./reader-answer-citation.logic";
import {
  attachReaderAnswerMarkers,
  jumpReaderAnswerCitation,
  openReaderAnswerFromMark,
  readerAnswerAnchors,
} from "./reader-answer-navigation";
import { readerAnswerFailureKind } from "./reader-answers.logic";
import type { ReaderAnswerFailureNotice } from "./reader-answers.logic";
import { useReaderAnswers } from "./use-reader-answers";

type DecisionWorkspaceDecision = Pick<
  PublicCaseLawDecision,
  | keyof DecisionDocumentState
  | "caseNumber"
  | "caseNumberType"
  | "country"
  | "court"
  | "courtAbbreviation"
  | "courtTier"
  | "decisionDate"
  | "decisionType"
  | "documentAst"
  | "ecli"
  | "fulltext"
  | "id"
  | "judges"
  | "language"
  | "metadata"
  | "source"
  | "sourceAttributionUrl"
  | "textFields"
  | "updatedAt"
>;

type DecisionWorkspaceBaseProps = {
  decision: DecisionWorkspaceDecision;
  decisionId: SafeId<"caseLawDecision">;
  /** The block the URL names, which the reader arrived at from a result row. */
  initialAnchorId?: string | undefined;
  /** A repeated citation is a fresh landing on the same passage. */
  landingSessionId?: string | undefined;
};

/**
 * A reader without an account, or a member whose own workspace chunk has not
 * arrived yet. The layer is named and offered where it would be drawn instead
 * of being hidden, and the account is asked for on the run.
 *
 * Nothing is read here: the public decision payload deliberately carries no
 * persisted analysis (`case-law-public-route-invariants.test.ts`, "public
 * decision payload does not expose persisted AI analysis"), and the endpoint
 * that would return one is behind `validateAuth`. So a decision that already
 * holds an analysis still shows the offer, and taking it up returns the
 * stored analysis through the authenticated read rather than running again.
 * Serving it to a visitor is a corpus-exposure decision for the API, not a
 * thing this component can decide.
 */
type GatedDecisionWorkspaceProps = DecisionWorkspaceBaseProps & {
  aiMode: "gated";
  /**
   * Opens the account gate. Absent while a member's workspace loads: the
   * column then names the layer without offering a run nobody owns yet.
   */
  onRequestAnalysis?: (() => void) | undefined;
};

type EnabledDecisionWorkspaceProps = DecisionWorkspaceBaseProps & {
  aiMode: "enabled";
  ensureAIAvailable: () => Promise<boolean>;
};

export type DecisionWorkspaceProps =
  EnabledDecisionWorkspaceProps | GatedDecisionWorkspaceProps;

/** What the margin's source filter means for the reader's own marks. */
/** A decision without a parsed body has no blocks to range over. */
const NO_BLOCKS: DocumentAst["blocks"] = [];

const decisionBlocks = (ast: DocumentAst | null): DocumentAst["blocks"] =>
  ast?.blocks ?? NO_BLOCKS;

const MARKS_FOR_NOTES_FILTER = {
  ai: "none",
  all: "all",
  mine: "mine",
} as const satisfies Record<NotesFilter, ReaderMarksFilter>;

const NotesFilterAllIcon = ({ className }: { className?: string }) => (
  <MatterIcon className={className} variant="all" />
);

type ReaderPanelToggleProps = {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onPress: () => void;
  pressed: boolean;
};

/** One toggle of the margin's floating display panel. */
const ReaderPanelToggle = ({
  icon: Icon,
  label,
  onPress,
  pressed,
}: ReaderPanelToggleProps) => {
  const t = useTranslations();
  return (
    <Tooltip
      content={t("caseLaw.notesFilter.toggleState", {
        label,
        state: pressed ? "on" : "off",
      })}
      render={
        <InspectorRailIconButton
          aria-label={label}
          aria-pressed={pressed}
          className={cn("rounded-none", pressed && "bg-muted text-foreground")}
          onClick={onPress}
        />
      }
    >
      <Icon className="size-4" />
    </Tooltip>
  );
};

export const DecisionWorkspace = (props: DecisionWorkspaceProps) => {
  const user = useMaybeAuthenticatedUser();
  return (
    <WebReaderProvider>
      <DecisionWorkspaceContent
        {...props}
        key={`${user?.activeOrganizationId ?? "guest"}:${user?.id ?? "guest"}:${props.decisionId}`}
      />
    </WebReaderProvider>
  );
};

type ParagraphLanding = ReturnType<typeof decisionParagraphLanding>;

export const ReaderStatusNotices = ({
  answerFailures,
  foreignDecisionError,
  isCreatingAnswer,
  paragraphLanding,
}: {
  answerFailures: readonly ReaderAnswerFailureNotice[];
  foreignDecisionError: unknown;
  isCreatingAnswer: boolean;
  paragraphLanding: ParagraphLanding;
}) => {
  const t = useTranslations();
  const reported = useRef(new Set<unknown>());
  useExternalSyncEffect(() => {
    for (const notice of answerFailures) {
      const identity =
        notice.type === "message" ? notice.messageId : notice.error;
      if (reported.current.has(identity)) {
        continue;
      }
      reported.current.add(identity);
      const { error } = notice;
      if (APIError.is(error) && error.status >= 400 && error.status < 500) {
        notifyUserError(error, t("errors.actionFailed"));
        continue;
      }
      const kind = readerAnswerFailureKind(error);
      let fallback = t("readerAnswers.modelError");
      if (kind === "budget") {
        fallback = t("readerAnswers.budgetError");
      } else if (kind === "network") {
        fallback = t("readerAnswers.networkError");
      } else if (kind === "timeout") {
        fallback = t("readerAnswers.timeoutError");
      }
      notifyUserError(error, fallback);
    }
    if (
      foreignDecisionError !== null &&
      foreignDecisionError !== undefined &&
      !reported.current.has(foreignDecisionError)
    ) {
      reported.current.add(foreignDecisionError);
      notifyUserError(foreignDecisionError, t("errors.actionFailed"));
    }
  }, [answerFailures, foreignDecisionError, t]);
  return (
    <>
      {isCreatingAnswer && (
        <p role="status" className="text-muted-foreground px-4 py-2 text-sm">
          {t("readerAnswers.loading")}
        </p>
      )}
      {(paragraphLanding.type === "range" ||
        paragraphLanding.type === "not-found") && (
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            paragraphLanding.type === "range"
              ? "sr-only"
              : "bg-muted text-muted-foreground px-4 py-2 text-sm",
          )}
        >
          {t(
            paragraphLanding.type === "range"
              ? "caseLaw.paragraphRangeSelected"
              : "caseLaw.paragraphRangeNotFound",
            {
              range: formatDecisionParagraphRange(paragraphLanding.range),
              count:
                paragraphLanding.range.to - paragraphLanding.range.from + 1,
            },
          )}
        </p>
      )}
    </>
  );
};

const decisionAnalysisView = (
  analysisState: ReturnType<typeof useLazyDecisionAnalysis>["state"],
) => {
  const hasAnalysis =
    analysisState.status === "done" ||
    (analysisState.status === "generating" && analysisState.tree.length > 0);
  // Streamed sections render as they arrive; the loader marks the remainder.
  const isAnalyzing = analysisState.status === "generating";
  const analysisTree = (() => {
    if (analysisState.status === "done") {
      return analysisState.analysis.tree;
    }
    if (analysisState.status === "generating") {
      return analysisState.tree;
    }
    return [];
  })();

  // The written layers come whole with the finished analysis; a run still
  // in flight streams only its tree, so there is nothing to show yet.
  const completeAnalysis =
    analysisState.status === "done" ? analysisState.analysis : null;

  return { hasAnalysis, isAnalyzing, analysisTree, completeAnalysis };
};

const DecisionWorkspaceContent = (props: DecisionWorkspaceProps) => {
  const { decision, decisionId, initialAnchorId, landingSessionId } = props;
  // The citation strip's own summary, already cached for this decision: a
  // later-treatment note is drawn only once it shows a later citing decision.
  // The strip reports a failed read; here it only keeps the note hidden.
  const citationSummary = useQueryView(
    useQuery(decisionCitationSummaryOptions(decisionId)),
  );
  const citedLater =
    citationSummary.type === "items" &&
    hasIncomingCitations(citationSummary.items);
  const t = useTranslations();
  const format = useFormatter();
  const ast = parseDocumentAst(decision.documentAst);
  const astBlocks = decisionBlocks(ast);
  // The case's citable name, for the legal copy modes.
  const caseName = decisionCaseName({
    ast,
    caseNumber: decision.caseNumber,
  });
  const annotationTarget = {
    type: "decision",
    caseNumber: decision.caseNumber,
    caseNumberType: decision.caseNumberType,
    country: decision.country,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType ?? null,
    ecli: decision.ecli ?? null,
    id: decisionId,
    name: caseName,
  } as const satisfies ReaderAnnotationTarget;
  const { element: contentElement, attach: attachContent } =
    useReaderElement<HTMLElement>();
  const {
    readerRef: mainRef,
    element: viewportElement,
    attach: attachViewport,
  } = useReaderElement<HTMLDivElement>();
  const provisions = useReaderProvisionMode(mainRef);
  const [notesFilter, setNotesFilter] = useState<NotesFilter>("all");
  const showAiNotes = NOTES_FILTER_SHOWS_AI[notesFilter];
  const annotations = useDecisionAnnotationSurface({
    marks: MARKS_FOR_NOTES_FILTER[notesFilter],
    scrollContainerRef: mainRef,
    target: annotationTarget,
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const answers = useReaderAnswers({
    decisionId,
    generationMode: props.aiMode,
  });
  const visibleAnswers = annotationsForMarksFilter(
    answers.answers,
    MARKS_FOR_NOTES_FILTER[notesFilter],
  );
  const [answerPlacement, setAnswerPlacement] = useState<"gutter" | "inline">(
    "gutter",
  );
  useMountEffect(() => {
    const aside = mainRef.current?.querySelector<HTMLElement>(
      "[data-reader-notes-column]",
    );
    if (!aside) {
      return undefined;
    }
    const measure = () =>
      setAnswerPlacement(
        aside.getBoundingClientRect().width > 0 ? "gutter" : "inline",
      );
    const observer = new ResizeObserver(measure);
    observer.observe(aside);
    measure();
    return () => observer.disconnect();
  });
  const openAnswer = useLatestCallback((id: string) => {
    annotations.clearActive();
    answers.activateAnswer(id);
  });
  const activateMark = (id: string | null) => {
    if (
      openReaderAnswerFromMark({
        id,
        answers: answers.answers,
        onOpen: openAnswer,
      })
    ) {
      return;
    }
    annotations.setActiveAnnotationId(id);
  };
  useExternalSyncEffect(() => {
    const root = viewportElement;
    if (root === null) {
      return undefined;
    }
    return attachReaderAnswerMarkers({
      root,
      answers: visibleAnswers,
      label: t("readerAnswers.expand"),
      onOpen: openAnswer,
    });
  }, [viewportElement, visibleAnswers, openAnswer, t]);
  const answerCitations = visibleAnswers.flatMap((answer) =>
    answer.messages.flatMap((message) => message.citations),
  );
  // These observers only watch the cache. A cited decision is fetched by the
  // chip that shows it, and chips render only in an expanded card, which
  // minimises once scrolled away: one read per distinct decision cited by the
  // cards on screen, never one for every answer the filter keeps. The open
  // action reads the same cache entries.
  const foreignDecisionIds = [
    ...new Set(answerCitations.map((citation) => citation.decisionId)),
  ].filter((id) => id !== decisionId);
  const foreignDecisions = useQueries({
    queries: foreignDecisionIds.map((id) => ({
      ...decisionOptions(id),
      enabled: false,
    })),
  });
  const foreignDecisionError = foreignDecisions.find(
    (query) => query.error !== null,
  )?.error;
  const citedDecisionReads = new Map(
    foreignDecisionIds.map((id, index) => {
      const query = foreignDecisions.at(index);
      return [
        id,
        query === undefined
          ? panic("Every cited decision must have a read")
          : citedDecisionRead(queryView(query)),
      ] as const;
    }),
  );
  useUnresolvedCitationTelemetry({
    blocks: astBlocks,
    ranges: answerCitations
      .filter((citation) => citation.decisionId === decisionId)
      .map(({ paragraphId }) => ({
        startAnchorId: paragraphId,
        endAnchorId: paragraphId,
      })),
    source: decisionId,
  });
  const answerNotes: AnswerMarginItem[] = visibleAnswers.map((answer) => ({
    kind: "answer",
    id: answer.id,
    startAnchorId: answer.anchor.spans[0].paragraphId,
    answer,
    generationMode: props.aiMode,
    active: answers.activeAnswerId === answer.id,
    openRevision: answers.openRevision,
    busy:
      answers.busyAnswerIds.has(answer.id) ||
      answer.messages.some((message) => message.status === "streaming"),
    onOpen: () => openAnswer(answer.id),
    onFollowUp: (question) =>
      detached(
        answers.followUp(answer.id, question),
        "reader-answer.follow-up",
      ),
    onRegenerate: () =>
      detached(answers.regenerate(answer.id), "reader-answer.regenerate"),
    onDelete: () => detached(answers.remove(answer.id), "reader-answer.delete"),
    onVisibility: (visibility) =>
      detached(
        answers.setVisibility(answer.id, visibility),
        "reader-answer.visibility",
      ),
    citationTarget: (citation) =>
      resolveReaderAnswerCitation({
        citation,
        decisionId,
        blocks: astBlocks,
        formatNumber: format.number,
        readCitedDecision: (id) =>
          citedDecisionReads.get(id) ??
          panic("Every cited decision must have a read"),
      }),
    language: decision.language,
    onCitation: (citation) =>
      detachedUserAction(
        jumpReaderAnswerCitation({
          citation,
          decisionId,
          root: mainRef.current,
          openDecision: async (id, paragraphId) => {
            const cited = await queryClient.query({
              ...decisionOptions(id),
              staleTime: "static",
            });
            const tab = createCaseDecisionViewTab({
              ...cited,
              decisionId: id,
              anchorId: paragraphId,
            });
            await navigateToCaseDecisionMain(navigate, tab.payload);
          },
        }),
        {
          context: "reader-answer.citation",
          failureMessage: t("errors.actionFailed"),
        },
      ),
  }));
  // A selection over any number of paragraphs is explained as a whole. The
  // server checks it against the same visible pieces, so Explain is offered
  // exactly where the server accepts it.
  const explainableSpans = (
    spans: SelectionAnchor[],
  ): ReaderAnswerSpans | undefined => {
    const [first, ...rest] = spans.map((span) => ({
      paragraphId: span.blockAnchorId,
      quote: span.quote,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
    }));
    return first !== undefined &&
      readerSelectionMatches(
        visibleReaderAnchorPiecesOf(ast, decision.caseNumberType),
        spans.map((span) => ({ ...span, anchorId: span.blockAnchorId })),
      )
      ? [first, ...rest]
      : undefined;
  };
  const explain = async (spans: SelectionAnchor[]) => {
    const selection = explainableSpans(spans);
    if (
      selection === undefined ||
      props.aiMode !== "enabled" ||
      !(await props.ensureAIAvailable())
    ) {
      return;
    }
    setNotesFilter("all");
    await answers.createExplain({ spans: selection });
  };
  // Only an account may start a run, so only this branch polls. Everything
  // below reads `analysisState` alone: a gated reader never starts a run, so
  // its state stays `idle` (the offer rather than an empty analysis column)
  // unless this session already fetched the finished analysis.
  const ensureAIAvailable =
    props.aiMode === "enabled" ? props.ensureAIAvailable : null;

  const [panelWidth, setPanelWidth] = useState(220);
  // The same per-browser size the inspector's readers step, so a size chosen
  // in either place holds in both.
  const textScale = useWebReaderTextScale("decision");
  const isDragging = useRef(false);
  // The text links every cited decision the first outgoing page resolves;
  // the panel below pages further, the links stop at what is already read.
  const citationAnchors = useDecisionCitationAnchors(decisionId);
  const {
    anchors: provisionAnchors,
    externalAnchors: externalProvisionAnchors,
  } = useDecisionProvisionAnchors({
    court: decision.court,
    caseNumber: decision.caseNumber,
    surface: "full-reader",
    blocks: visibleDecisionBlocks(
      ast,
      decision.caseNumberType,
      decision.fulltext,
    ),
    country: decision.country,
    decisionId,
    decisionDate: decision.decisionDate,
  });
  const statuteCitationAnchors = useDecisionStatuteCitationAnchors(
    visibleDecisionBlocks(ast, decision.caseNumberType, decision.fulltext),
    decision.decisionDate,
  );

  const { state: analysisState, generate: generateDecisionAnalysis } =
    useLazyDecisionAnalysis({
      decisionId,
      decisionUpdatedAt: decision.updatedAt,
      documentReady: ast !== null,
      sourceAllowsDerivedAi: decision.source.allowsDerivedAi,
      mode: props.aiMode,
    });
  const generate = useCallback(async () => {
    if (!ensureAIAvailable) {
      return;
    }

    const available = await ensureAIAvailable();
    if (!available) {
      return;
    }

    generateDecisionAnalysis();
  }, [ensureAIAvailable, generateDecisionAnalysis]);

  const { hasAnalysis, isAnalyzing, analysisTree, completeAnalysis } =
    decisionAnalysisView(analysisState);

  const fallbackBreadcrumb = useAnalysisReaderBreadcrumb(
    completeAnalysis?.tree ?? null,
  );

  // The passage the reader was sent to, marked for as long as they are on it.
  // A jump anywhere else in the document is them leaving it, so the marker
  // goes. A new decision starts the question over, and so does a new fragment
  // on the same one: stepping back to `#p-1` from `#p-2` keeps this component
  // mounted, so the decision alone cannot tell the two landings apart.
  const landingRoute = `${decisionId}#${initialAnchorId ?? ""}#${landingSessionId ?? ""}`;
  const paragraphLanding = decisionParagraphLanding(ast, initialAnchorId);
  const resolvedLandingAnchorId =
    paragraphLanding.type === "anchor" ? paragraphLanding.anchorId : undefined;
  const [landingAnchorId, setLandingAnchorId] = useState(
    resolvedLandingAnchorId,
  );
  const [landingFor, setLandingFor] = useState(landingRoute);
  if (landingFor !== landingRoute) {
    setLandingFor(landingRoute);
    setLandingAnchorId(resolvedLandingAnchorId);
  }

  useDecisionParagraphLanding({
    containerRef: mainRef,
    documentAst: decision.documentAst,
    fragment: initialAnchorId,
    sessionId: landingSessionId,
  });

  const jumpToAnchor = (anchorId: string, endAnchorId = anchorId) => {
    setLandingAnchorId(undefined);
    const container = mainRef.current;
    const el = container?.querySelector<HTMLElement>(
      `#${CSS.escape(anchorId)}`,
    );
    if (!container || !el) {
      return;
    }
    container.scrollTo({
      top:
        el.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop,
      behavior: "instant",
    });
    const blocks = astBlocks;
    const range = paragraphRangeIndices(blocks, {
      startAnchorId: anchorId,
      endAnchorId,
    });
    const highlighted =
      range === null ? [] : blocks.slice(range.startIndex, range.endIndex + 1);
    const highlightedElements = highlighted
      .map((block) =>
        container.querySelector<HTMLElement>(`#${CSS.escape(block.anchorId)}`),
      )
      .filter((blockElement) => blockElement !== null);
    if (highlightedElements.length === 0) {
      highlightedElements.push(el);
    }
    for (const blockElement of highlightedElements) {
      delete blockElement.dataset["highlight"];
    }
    forceReflow(el);
    for (const blockElement of highlightedElements) {
      blockElement.dataset["highlight"] = "";
    }
  };

  // The model's headnote and abstract open the decision, under the court's
  // own and drawn the same way: they are what a reader wants before the text,
  // and the margin column that used to hold them is not there below the lg
  // width.
  const aiHeadnotes =
    completeAnalysis !== null &&
    showAiNotes &&
    hasAiHeadnotes(completeAnalysis) ? (
      <AiHeadnotes
        analysis={completeAnalysis}
        blocks={astBlocks}
        language={decision.language}
        onAnchorClick={jumpToAnchor}
      />
    ) : null;

  const sectionMap = (() => {
    if (analysisTree.length === 0 || !ast) {
      return undefined;
    }
    const anchorIds = ast.blocks.map((b) => b.anchorId);
    return buildSectionMap(analysisTree, anchorIds);
  })();

  const flatAnalysisHeadings = flattenAnalysisHeadings(analysisTree);

  // Analysis outline for the shared rail: category colours + display anchors.
  const analysisOutline = (() => {
    const items: OutlineItem[] = [];
    const anchorById = new Map<string, string>();
    for (const heading of flatAnalysisHeadings) {
      items.push({
        id: heading.id,
        label: heading.label,
        level: heading.depth,
        color: getCategoryVar(heading.category),
      });
      anchorById.set(heading.id, getHeadingDisplayAnchorId(heading));
    }
    return { items, anchorById };
  })();

  const marginItems = flatAnalysisHeadings.flatMap((heading) => {
    const items: AnalysisMarginItem[] = [];
    const first = heading.annotations.at(0);

    items.push({
      kind: "card",
      id: heading.id,
      heading: heading.label,
      text: first?.summary ?? "",
      accentVar: getCategoryVar(heading.category),
      depth: heading.depth,
      startAnchorId: first?.startAnchorId ?? heading.startAnchorId,
    });

    for (const annotation of heading.annotations.slice(first ? 1 : 0)) {
      items.push({
        kind: "annotation",
        id: annotation.id,
        text: annotation.summary,
        accentVar: getCategoryVar(heading.category),
        depth: heading.depth + 1,
        startAnchorId: annotation.startAnchorId,
      });
    }

    return items;
  });

  const visitorOffer = resolveVisitorOffer({
    analysisStatus: analysisState.status,
    notesFilter,
    onRequest: props.aiMode === "gated" ? props.onRequestAnalysis : undefined,
  });

  // A visitor sees the shape the notes would take, where they would sit,
  // until there is an analysis to show instead.
  const exampleMarginItems: AnalysisMarginItem[] =
    visitorOffer !== undefined
      ? exampleNoteAnchors({
          anchorIds: visibleDecisionBlocks(ast, decision.caseNumberType).map(
            (block) => block.anchorId,
          ),
          seed: decisionId,
        }).flatMap((startAnchorId, index) => {
          const note = EXAMPLE_NOTES.at(index);
          return note === undefined
            ? []
            : [
                {
                  kind: "example",
                  id: `example:${note.category}`,
                  heading: t(`caseLaw.analysis.categories.${note.category}`),
                  accentVar: getCategoryVar(note.category),
                  depth: 0,
                  lines: note.lines,
                  startAnchorId,
                },
              ];
        })
      : [];

  const visibleMarginItems = [
    ...(answerPlacement === "gutter" ? answerNotes : []),
    ...(hasAnalysis && showAiNotes ? marginItems : []),
    ...(provisions.expandProvisions && answerPlacement === "gutter"
      ? prepareDecisionProvisionCards({
          blocks: visibleDecisionBlocks(ast, decision.caseNumberType),
          provisionAnchors,
        }).map(({ citations, id, startAnchorId }): ProvisionMarginItem => ({
          citations,
          id: `provision:${id}`,
          kind: "provision",
          startAnchorId,
        }))
      : []),
    ...exampleMarginItems,
    ...annotations.notes,
  ];

  const notesFilterOptions = [
    { icon: NotesFilterAllIcon, label: t("common.all"), value: "all" },
    { icon: SparklesIcon, label: t("caseLaw.notesFilter.ai"), value: "ai" },
    {
      icon: UserRoundIcon,
      label: t("inbox.filter.mine"),
      value: "mine",
    },
  ] as const satisfies readonly {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: NotesFilter;
  }[];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* The margin's panel holds the toggle. Below `lg` neither is drawn
          and the provisions open under their paragraphs, so the header holds
          it, as the inspector's pane does. */}
      {answerPlacement === "inline" && (
        <ChromeHeaderActions>
          <ReaderProvisionModeToggle mode={provisions} size="page" />
        </ChromeHeaderActions>
      )}
      <GuestAnnotationPrompt count={annotations.guestCount} />
      <h1 className="sr-only" data-slot="decision-title">
        <BidiText as="span">{decision.caseNumber}</BidiText>
      </h1>
      <div
        className={cn(
          LEGAL_READER_LAYOUT_CLASS_NAME,
          "relative min-h-0 flex-1",
        )}
      >
        <LegalReaderControls
          textScale={textScale}
          blocks={ast === null ? [] : ast.blocks}
          content={contentElement}
          fallbackBreadcrumb={fallbackBreadcrumb}
          viewport={viewportElement}
          key={decisionId}
        />
        <div className="bg-background/80 supports-[backdrop-filter]:bg-background/55 shadow-floating absolute start-3 bottom-3 z-30 flex items-center overflow-hidden rounded-lg border backdrop-blur-xl max-lg:hidden">
          {notesFilterOptions.map((option) => (
            <ReaderPanelToggle
              icon={option.icon}
              key={option.value}
              label={option.label}
              onPress={() => {
                annotations.clearActive();
                setNotesFilter(option.value);
              }}
              pressed={notesFilter === option.value}
            />
          ))}
          {/* The filter picks one source; the provisions show beside any. */}
          <Separator orientation="vertical" />
          <ReaderPanelToggle
            icon={ScrollTextIcon}
            label={t("caseLaw.viewer.provisionsCited")}
            onPress={provisions.toggle}
            pressed={provisions.expandProvisions}
          />
        </div>
        {/* The text column is the grid's inline-end column at every width, so
            the bar's corner of this box is the text's corner, as in the
            inspector's reader. */}

        {/* The composer floats over the text here as it does in the inspector's
            reader, bound to the same decision and so to the same conversation.
            The annotation toolbar stays outside it: it belongs to the marks on
            the text, not to the chat. */}
        {/* The composer centres on the text column, not on the pane: at `lg`
            the analysis column stands beside the text, so the docked
            composer's start inset is that column's width; below `lg` the
            grid is one column and the inset is zero. */}
        <div
          className="h-full [--docked-composer-inset-start:0px] lg:[--docked-composer-inset-start:var(--reader-aside-width)]"
          style={{ "--reader-aside-width": `${panelWidth}px` }}
        >
          <LegalReaderAIChat
            activeLegal={activeLegalFromReaderTarget(annotationTarget)}
            aiMode={props.aiMode}
            className="h-full"
          >
            {/* The outline shares the composer's positioned host so it inherits
                the published block-end inset as the composer grows. */}
            {showAiNotes && hasAnalysis && analysisTree.length > 0 && (
              <OutlineRail
                ariaLabel={t("statutes.outline")}
                items={analysisOutline.items}
                // The shared breadcrumb and zoom row owns the top band.
                topOffset={READER_BREADCRUMB_CLEARANCE}
                onJump={(id, container) => {
                  const anchorId = analysisOutline.anchorById.get(id);
                  if (anchorId === undefined) {
                    return;
                  }
                  setLandingAnchorId(undefined);
                  const el = container.querySelector<HTMLElement>(
                    `#${CSS.escape(anchorId)}`,
                  );
                  if (!el) {
                    return;
                  }
                  container.scrollTo({
                    top:
                      el.getBoundingClientRect().top -
                      container.getBoundingClientRect().top +
                      container.scrollTop,
                    behavior: "instant",
                  });
                  delete el.dataset["highlight"];
                  forceReflow(el);
                  el.dataset["highlight"] = "";
                }}
                resolvePct={(id, container) => {
                  const anchorId = analysisOutline.anchorById.get(id);
                  if (anchorId === undefined || container.scrollHeight <= 0) {
                    return null;
                  }
                  const el = container.querySelector<HTMLElement>(
                    `#${CSS.escape(anchorId)}`,
                  );
                  if (!el) {
                    return null;
                  }
                  const top =
                    el.getBoundingClientRect().top -
                    container.getBoundingClientRect().top +
                    container.scrollTop;
                  return Math.min(
                    99,
                    Math.max(1, (top / container.scrollHeight) * 100),
                  );
                }}
                scrollContainerRef={mainRef}
              />
            )}
            <div
              className="reader-scroll h-full overflow-y-auto"
              ref={attachViewport}
            >
              <ReaderStatusNotices
                answerFailures={answers.failureNotices}
                foreignDecisionError={foreignDecisionError}
                isCreatingAnswer={answers.isCreating}
                paragraphLanding={paragraphLanding}
              />
              <div
                className="grid max-lg:!grid-cols-[1fr]"
                {...textScale.rootProps}
                style={{
                  ...textScale.rootProps.style,
                  gridTemplateColumns: `${panelWidth}px minmax(0, 1fr)`,
                }}
              >
                {/* Before a visitor has an account, the notes column is the
                    offer: a click on its surface or an example note asks for
                    the account. The reader's own comments stay usable. The
                    prompt's own button is the keyboard path to the same gate. */}
                {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- pointer shortcut only; the sticky prompt's button is the keyboard path */}
                <aside
                  data-reader-notes-column=""
                  className={cn(
                    "relative flex flex-col max-lg:hidden",
                    visitorOffer !== undefined && "cursor-pointer",
                  )}
                  onClick={
                    visitorOffer === undefined
                      ? undefined
                      : (event) => {
                          if (clickOpensVisitorOffer(event.target)) {
                            visitorOffer();
                          }
                        }
                  }
                >
                  {completeAnalysis !== null && showAiNotes && (
                    <AnalysisLayers
                      analysis={completeAnalysis}
                      citedLater={citedLater}
                    />
                  )}
                  {hasAnalysis &&
                    showAiNotes &&
                    flatAnalysisHeadings.length > 0 && (
                      <CurrentSection
                        anchorById={analysisOutline.anchorById}
                        headings={flatAnalysisHeadings}
                        scrollContainerRef={mainRef}
                      />
                    )}
                  {showAiNotes && isAnalyzing && (
                    <div className="px-2 pt-8">
                      <AnalysisLoader />
                    </div>
                  )}
                  {showAiNotes &&
                    props.aiMode === "gated" &&
                    analysisState.status === "idle" && (
                      <GatedAnalysisInvitation
                        onRequest={props.onRequestAnalysis}
                      />
                    )}
                  {showAiNotes && analysisState.status === "error" && (
                    <AnalysisErrorNotice
                      error={analysisState.error}
                      onRetry={() => {
                        detached(generate(), "decision-workspace.generate");
                      }}
                    />
                  )}

                  {/* The notes are painted absolutely inside this region, so they
                    are measured against the space the layers above them leave
                    free instead of against the whole column. */}
                  <div className="relative flex-1">
                    {visibleMarginItems.length > 0 && (
                      <MarginNotes
                        items={visibleMarginItems}
                        placement="gutter"
                        scrollContainerRef={mainRef}
                      />
                    )}
                  </div>

                  <div
                    className="group hover:bg-border/50 active:bg-border absolute inset-y-0 -end-px z-10 flex w-2 cursor-col-resize items-center justify-center"
                    data-slot={READER_ASIDE_RESIZE_SLOT}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      isDragging.current = true;
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!isDragging.current) {
                        return;
                      }

                      const aside = event.currentTarget.parentElement;
                      if (!aside) {
                        return;
                      }

                      const newWidth =
                        event.clientX - aside.getBoundingClientRect().left;
                      setPanelWidth(Math.min(400, Math.max(120, newWidth)));
                    }}
                    onPointerUp={() => {
                      isDragging.current = false;
                    }}
                  >
                    <div className="flex flex-col gap-[3px] opacity-0 transition-opacity group-hover:opacity-40">
                      <div className="bg-foreground h-[3px] w-[3px] rounded-full" />
                      <div className="bg-foreground h-[3px] w-[3px] rounded-full" />
                      <div className="bg-foreground h-[3px] w-[3px] rounded-full" />
                    </div>
                  </div>
                </aside>

                <main
                  className={cn(
                    "reader-paper min-w-0 pb-8",
                    LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME,
                  )}
                  ref={attachContent}
                  data-slot="reader-document-column"
                >
                  {/* Below lg the analysis column, and the offer in it, is
                      not drawn; a visitor still has to learn the layer
                      exists and that signing in opens it. */}
                  {showAiNotes &&
                    props.aiMode === "gated" &&
                    props.onRequestAnalysis !== undefined &&
                    analysisState.status === "idle" && (
                      <NarrowGatedAnalysisInvitation
                        onRequest={props.onRequestAnalysis}
                      />
                    )}
                  <DecisionText
                    surface="full-reader"
                    aiHeadnotes={aiHeadnotes}
                    annotationAnchors={[
                      ...annotations.anchors,
                      ...readerAnswerAnchors(
                        visibleAnswers,
                        t("readerAnswers.expand"),
                      ),
                    ]}
                    citationAnchors={citationAnchors}
                    decision={decision}
                    decisionId={decisionId}
                    expandProvisions={
                      provisions.expandProvisions &&
                      answerPlacement === "inline"
                    }
                    landingAnchorId={landingAnchorId}
                    onAnnotationActivate={activateMark}
                    notesByAnchorId={
                      answerPlacement === "inline"
                        ? new Map(
                            answerNotes.map((note) => [
                              note.startAnchorId,
                              <MarginNotes
                                key={note.startAnchorId}
                                items={answerNotes.filter(
                                  (item) =>
                                    item.startAnchorId === note.startAnchorId,
                                )}
                                placement="inline"
                              />,
                            ]),
                          )
                        : undefined
                    }
                    landingSessionId={landingSessionId}
                    provisionAnchors={provisionAnchors}
                    externalProvisionAnchors={externalProvisionAnchors}
                    sectionMap={showAiNotes ? sectionMap : undefined}
                    statuteCitationAnchors={statuteCitationAnchors}
                  />
                </main>
              </div>
            </div>
          </LegalReaderAIChat>
        </div>
        <AnnotationToolbar
          activeAnnotation={annotations.activeAnnotation}
          activeSpans={annotations.activeSpans}
          controller={annotations.controller}
          mode={annotations.mode}
          onActivateAnnotation={activateMark}
          onClearActive={annotations.clearActive}
          onCompose={annotations.startComposing}
          onExplain={
            props.aiMode === "enabled"
              ? (spans) => detached(explain(spans), "reader-answer.explain")
              : undefined
          }
          explainRefusal={(spans) =>
            explainableSpans(spans) === undefined
              ? t("readerAnswers.selectionError")
              : undefined
          }
          scrollContainerRef={mainRef}
          target={annotationTarget}
        />
      </div>
    </div>
  );
};

const AnalysisLoader = () => {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-4 px-2 pt-4">
      <div className="flex items-center gap-2">
        <Loader label={t("caseLaw.analyzing")} size="sm" />
        <span className="text-foreground-strong-muted text-xs font-medium">
          {t("caseLaw.analyzing")}
        </span>
      </div>
      {[0.6, 0.8, 0.5, 0.7, 0.45, 0.65].map((width, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- static skeleton-loader placeholder widths, never reorders
        <div className="flex flex-col gap-1.5" key={index}>
          <Skeleton
            className="h-2.5"
            style={{
              width: `${width * 100}%`,
              animationDelay: `${index * 150}ms`,
            }}
          />
          {index % 2 === 0 && (
            <Skeleton
              className="ms-3 h-2"
              style={{
                width: `${width * 70}%`,
                animationDelay: `${index * 150 + 75}ms`,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
};

/**
 * The analysis column's offer, above the text where that column is not drawn.
 */
const NarrowGatedAnalysisInvitation = ({
  onRequest,
}: {
  onRequest: () => void;
}) => {
  const t = useTranslations();

  return (
    <div
      aria-label={t("caseLaw.notesFilter.ai")}
      className="reader-chrome mx-auto mb-6 flex max-w-(--reader-measure) flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 lg:hidden"
      data-slot="gated-analysis-invitation-narrow"
      role="region"
    >
      <SparklesIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
      <p className="text-foreground-strong-muted min-w-0 flex-1 text-sm leading-snug">
        {t("caseLaw.analysis.invitation")}
      </p>
      <Button onClick={onRequest} size="sm" variant="muted">
        {t("auth.signIn")}
      </Button>
    </div>
  );
};

/**
 * The analysis column's offer before a run. A visitor also sees example
 * notes in the margin beside the text (`exampleNoteAnchors`); this box says
 * what a free account unlocks. Without a handler the column only names the
 * layer, which is what a member's loading shell needs.
 */
const GatedAnalysisInvitation = ({
  onRequest,
}: {
  onRequest?: (() => void) | undefined;
}) => {
  const t = useTranslations();

  if (onRequest === undefined) {
    return (
      <div
        aria-label={t("caseLaw.notesFilter.ai")}
        className="mx-2 mt-8 flex justify-center"
        data-slot="gated-analysis-invitation"
        role="region"
      >
        <span className="text-muted-foreground text-xs">
          <ReaderAiLabel
            context="caseLaw"
            label={t("caseLaw.notesFilter.ai")}
          />
        </span>
      </div>
    );
  }

  return (
    <div
      aria-label={t("caseLaw.notesFilter.ai")}
      // Pinned while the example notes scroll past beneath it.
      className="bg-background/75 supports-[backdrop-filter]:bg-background/55 sticky top-4 z-20 mx-2 mt-8 flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center shadow-sm backdrop-blur-xl"
      data-slot="gated-analysis-invitation"
      role="region"
    >
      <p className="text-foreground-strong-muted text-xs leading-snug">
        {t("caseLaw.analysis.invitation")}
      </p>
      <Button
        onClick={(event) => {
          // The column around it asks for the account too; ask once.
          event.stopPropagation();
          onRequest();
        }}
        size="sm"
        variant="muted"
      >
        <SparklesIcon className="size-3" />
        {t("caseLaw.analysis.generate")}
      </Button>
    </div>
  );
};
