import { useCallback, useRef, useState } from "react";

import { SparklesIcon, UserRoundIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { InspectorRailIconButton } from "@stll/ui/inspector";
import { Loader } from "@stll/ui/loader";
import { OutlineRail } from "@stll/ui/outline-rail";
import type { OutlineItem } from "@stll/ui/outline-rail";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { activeLegalFromReaderTarget } from "@/components/ai-suggestions/active-legal-document";
import { AnnotationToolbar } from "@/components/legal-reader/annotations/annotation-toolbar";
import { GuestAnnotationPrompt } from "@/components/legal-reader/annotations/guest-annotation-prompt";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import { LegalReaderAIChat } from "@/components/legal-reader/legal-reader-ai-chat";
import { MatterIcon } from "@/components/matter-icon";
import Tooltip from "@/components/tooltip";
import {
  AiHeadnotes,
  hasAiHeadnotes,
} from "@/features/case-law/components/case-viewer/analysis/ai-headnotes";
import { AnalysisLayers } from "@/features/case-law/components/case-viewer/analysis/analysis-layers";
import { CurrentSection } from "@/features/case-law/components/case-viewer/analysis/current-section";
import {
  EXAMPLE_NOTES,
  exampleNoteAnchors,
} from "@/features/case-law/components/case-viewer/analysis/example-notes.logic";
import { MarginNotes } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import type { AnalysisMarginItem } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import {
  buildSectionMap,
  flattenAnalysisHeadings,
  getCategoryVar,
} from "@/features/case-law/components/case-viewer/analysis/types";
import { useDecisionAnalysis } from "@/features/case-law/components/case-viewer/analysis/use-decision-analysis";
import type { ReaderMarksFilter } from "@/features/case-law/components/case-viewer/decision-annotation-surface.logic";
import type { DecisionDocumentState } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import {
  decisionCaseName,
  visibleDecisionBlocks,
} from "@/features/case-law/components/case-viewer/decision-text.logic";
import { useDecisionAnnotationSurface } from "@/features/case-law/components/case-viewer/use-decision-annotation-surface";
import { useDecisionCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-citation-anchors";
import { useDecisionProvisionAnchors } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import { useDecisionStatuteCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-statute-citation-anchors";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useCaseSearchStore } from "@/lib/case-search-store";
import { detached } from "@/lib/detached";
import type { SafeId } from "@/lib/safe-id";
import { forceReflow } from "@/lib/utils";

type DecisionWorkspaceDecision = Pick<
  PublicCaseLawDecision,
  | keyof DecisionDocumentState
  | "caseNumber"
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
  | "sourceAttributionUrl"
  | "textFields"
  | "updatedAt"
>;

type DecisionWorkspaceBaseProps = {
  decision: DecisionWorkspaceDecision;
  decisionId: SafeId<"caseLawDecision">;
  /** The block the URL names, which the reader arrived at from a result row. */
  initialAnchorId?: string | undefined;
  initialSearchQuery?: string | undefined;
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
  | EnabledDecisionWorkspaceProps
  | GatedDecisionWorkspaceProps;

const getHeadingDisplayAnchorId = ({
  annotations,
  startAnchorId,
}: {
  annotations: { startAnchorId: string }[];
  startAnchorId: string;
}) => annotations.at(0)?.startAnchorId ?? startAnchorId;

/** The notes margin's mutually exclusive source filter. */
type NotesFilter = "all" | "ai" | "mine";

/** What the margin's source filter means for the reader's own marks. */
const MARKS_FOR_NOTES_FILTER = {
  ai: "none",
  all: "all",
  mine: "mine",
} as const satisfies Record<NotesFilter, ReaderMarksFilter>;

const NotesFilterAllIcon = ({ className }: { className?: string }) => (
  <MatterIcon className={className} variant="all" />
);

export const DecisionWorkspace = (props: DecisionWorkspaceProps) => {
  const { decision, decisionId, initialAnchorId, initialSearchQuery } = props;
  const t = useTranslations();
  const ast = parseDocumentAst(decision.documentAst);
  // The case's citable name, for the legal copy modes.
  const caseName = decisionCaseName({
    ast,
    caseNumber: decision.caseNumber,
  });
  const annotationTarget = {
    type: "decision",
    caseNumber: decision.caseNumber,
    country: decision.country,
    court: decision.court,
    decisionDate: decision.decisionDate,
    decisionType: decision.decisionType ?? null,
    ecli: decision.ecli ?? null,
    id: decisionId,
    name: caseName,
  } as const satisfies ReaderAnnotationTarget;
  const mainRef = useRef<HTMLDivElement>(null);
  const [notesFilter, setNotesFilter] = useState<NotesFilter>("all");
  const showAiNotes = notesFilter === "all" || notesFilter === "ai";
  const annotations = useDecisionAnnotationSurface({
    marks: MARKS_FOR_NOTES_FILTER[notesFilter],
    scrollContainerRef: mainRef,
    target: annotationTarget,
  });
  // Only an account may start a run, so only this branch polls. Everything
  // below reads `analysisState` alone: a gated reader never starts a run, so
  // its state stays `idle` (the offer rather than an empty analysis column)
  // unless this session already fetched the finished analysis.
  const analysisRunnable = props.aiMode === "enabled";
  const ensureAIAvailable =
    props.aiMode === "enabled" ? props.ensureAIAvailable : null;

  const [panelWidth, setPanelWidth] = useState(220);
  const isDragging = useRef(false);
  const {
    searchOpen,
    searchQuery,
    activeMatchIndex,
    openSearch,
    setMatchCount,
    setSearchQuery,
  } = useCaseSearchStore(
    useShallow((s) => ({
      searchOpen: s.isOpen,
      searchQuery: s.query,
      activeMatchIndex: s.activeMatchIndex,
      openSearch: s.open,
      setMatchCount: s.setMatchCount,
      setSearchQuery: s.setQuery,
    })),
  );

  // The text links every cited decision the first outgoing page resolves;
  // the panel below pages further, the links stop at what is already read.
  const citationAnchors = useDecisionCitationAnchors(decisionId);
  const provisionAnchors = useDecisionProvisionAnchors({
    blocks: visibleDecisionBlocks(ast),
    country: decision.country,
    decisionId,
    decisionDate: decision.decisionDate,
  });
  const statuteCitationAnchors = useDecisionStatuteCitationAnchors(
    visibleDecisionBlocks(ast),
    decision.decisionDate,
  );

  const { state: analysisState, generate: generateDecisionAnalysis } =
    useDecisionAnalysis({
      decisionId,
      decisionUpdatedAt: decision.updatedAt,
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

  const hasAnalysis =
    analysisState.status === "done" ||
    (analysisState.status === "generating" && analysisState.tree.length > 0);
  const isAnalyzing =
    analysisState.status === "generating" && analysisState.tree.length === 0;
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

  // The passage the reader was sent to, marked for as long as they are on it.
  // A jump anywhere else in the document is them leaving it, so the marker
  // goes. A new decision starts the question over, and so does a new fragment
  // on the same one: stepping back to `#p-1` from `#p-2` keeps this component
  // mounted, so the decision alone cannot tell the two landings apart.
  const landingRoute = `${decisionId}#${initialAnchorId ?? ""}`;
  const [landingAnchorId, setLandingAnchorId] = useState(initialAnchorId);
  const [landingFor, setLandingFor] = useState(landingRoute);
  if (landingFor !== landingRoute) {
    setLandingFor(landingRoute);
    setLandingAnchorId(initialAnchorId);
  }

  const jumpToAnchor = (anchorId: string) => {
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
    delete el.dataset["highlight"];
    forceReflow(el);
    el.dataset["highlight"] = "";
  };

  // The model's headnote and abstract open the decision, under the court's
  // own and drawn the same way: they are what a reader wants before the text,
  // and the margin column that used to hold them is not there below the lg
  // width.
  const aiHeadnotes =
    completeAnalysis !== null &&
    showAiNotes &&
    hasAiHeadnotes(completeAnalysis) ? (
      <AiHeadnotes analysis={completeAnalysis} onAnchorClick={jumpToAnchor} />
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
      category: heading.category,
      depth: heading.depth,
      startAnchorId: first?.startAnchorId ?? heading.startAnchorId,
    });

    for (const annotation of heading.annotations.slice(first ? 1 : 0)) {
      items.push({
        kind: "annotation",
        id: annotation.id,
        text: annotation.summary,
        category: heading.category,
        depth: heading.depth + 1,
        startAnchorId: annotation.startAnchorId,
      });
    }

    return items;
  });

  // A visitor sees the shape the notes would take, where they would sit,
  // until there is an analysis to show instead.
  const exampleMarginItems: AnalysisMarginItem[] =
    props.aiMode === "gated" &&
    props.onRequestAnalysis !== undefined &&
    analysisState.status === "idle"
      ? exampleNoteAnchors({
          anchorIds: visibleDecisionBlocks(ast).map((block) => block.anchorId),
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
                  category: note.category,
                  depth: 0,
                  lines: note.lines,
                  startAnchorId,
                },
              ];
        })
      : [];

  const visibleMarginItems = [
    ...(hasAnalysis && showAiNotes ? marginItems : []),
    ...(showAiNotes ? exampleMarginItems : []),
    ...annotations.notes,
  ];

  useExternalSyncEffect(() => {
    if (analysisRunnable && ast && analysisState.status === "idle") {
      detached(generate(), "decision-workspace.generate");
    }
  }, [analysisRunnable, analysisState.status, ast, generate]);

  const reset = useCaseSearchStore((s) => s.reset);
  useExternalSyncEffect(() => {
    reset();
    if (initialSearchQuery) {
      setSearchQuery(initialSearchQuery);
      openSearch();
    }
  }, [decisionId, initialSearchQuery, openSearch, reset, setSearchQuery]);

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
      <GuestAnnotationPrompt count={annotations.guestCount} />
      <h1 className="sr-only" data-slot="decision-title">
        <BidiText as="span">{decision.caseNumber}</BidiText>
      </h1>
      <div className="relative min-h-0 flex-1">
        <div className="bg-background/80 supports-[backdrop-filter]:bg-background/55 shadow-floating absolute start-3 bottom-3 z-30 flex items-center overflow-hidden rounded-lg border backdrop-blur-xl max-lg:hidden">
          {notesFilterOptions.map((option) => {
            const Icon = option.icon;
            const isActive = notesFilter === option.value;
            return (
              <Tooltip
                content={option.label}
                key={option.value}
                render={
                  <InspectorRailIconButton
                    aria-label={option.label}
                    aria-pressed={isActive}
                    className={cn(
                      "rounded-none",
                      isActive && "bg-muted text-foreground",
                    )}
                    onClick={() => {
                      annotations.clearActive();
                      setNotesFilter(option.value);
                    }}
                  />
                }
              >
                <Icon className="size-4" />
              </Tooltip>
            );
          })}
        </div>
        {showAiNotes && hasAnalysis && analysisTree.length > 0 && (
          <OutlineRail
            items={analysisOutline.items}
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
            className="h-full"
          >
            <div className="reader-scroll h-full overflow-y-auto" ref={mainRef}>
              <div
                className="grid max-lg:!grid-cols-[1fr]"
                style={{
                  gridTemplateColumns: `${panelWidth}px minmax(0, 1fr)`,
                }}
              >
                <aside className="relative flex flex-col max-lg:hidden">
                  {completeAnalysis !== null && showAiNotes && (
                    <AnalysisLayers analysis={completeAnalysis} />
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
                    <div
                      className="bg-background/75 supports-[backdrop-filter]:bg-background/55 mx-2 mt-8 flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center shadow-sm backdrop-blur-xl"
                      role="alert"
                    >
                      <p className="text-muted-foreground text-xs leading-snug">
                        {t("errors.api.server")}
                      </p>
                      <Button
                        onClick={() => {
                          detached(generate(), "decision-workspace.generate");
                        }}
                        size="sm"
                        variant="muted"
                      >
                        <SparklesIcon className="size-3" />
                        {t("common.retry")}
                      </Button>
                    </div>
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
                  className="reader-paper min-w-0 py-8"
                  data-slot="reader-document-column"
                >
                  <DecisionText
                    activeMatchIndex={activeMatchIndex}
                    aiHeadnotes={aiHeadnotes}
                    annotationAnchors={annotations.anchors}
                    citationAnchors={citationAnchors}
                    decision={decision}
                    decisionId={decisionId}
                    landingAnchorId={landingAnchorId}
                    onAnnotationActivate={annotations.setActiveAnnotationId}
                    onMatchCountChange={setMatchCount}
                    provisionAnchors={provisionAnchors}
                    searchQuery={searchOpen ? searchQuery : ""}
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
          onActivateAnnotation={annotations.setActiveAnnotationId}
          onClearActive={annotations.clearActive}
          onCompose={annotations.startComposing}
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
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <SparklesIcon className="size-3.5" />
          {t("caseLaw.notesFilter.ai")}
        </span>
      </div>
    );
  }

  return (
    <div
      aria-label={t("caseLaw.notesFilter.ai")}
      className="bg-background/75 supports-[backdrop-filter]:bg-background/55 mx-2 mt-8 flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-center shadow-sm backdrop-blur-xl"
      data-slot="gated-analysis-invitation"
      role="region"
    >
      <p className="text-foreground-strong-muted text-xs leading-snug">
        {t("caseLaw.analysis.invitation")}
      </p>
      <Button onClick={onRequest} size="sm" variant="muted">
        <SparklesIcon className="size-3" />
        {t("caseLaw.analysis.generate")}
      </Button>
    </div>
  );
};
