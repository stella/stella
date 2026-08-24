import { useCallback, useRef, useState } from "react";

import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { OutlineRail } from "@stll/ui/outline-rail";
import type { OutlineItem } from "@stll/ui/outline-rail";

import type { SelectionAnchor } from "@/features/case-law/annotations/selection-anchor";
import { isPendingAnnotationId } from "@/features/case-law/annotations/use-decision-annotations";
import { MarginNotes } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import type {
  AnalysisMarginItem,
  CommentMarginItem,
  ComposerMarginItem,
} from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import {
  buildSectionMap,
  flattenAnalysisHeadings,
  getCategoryVar,
} from "@/features/case-law/components/case-viewer/analysis/types";
import { useDecisionAnalysis } from "@/features/case-law/components/case-viewer/analysis/use-decision-analysis";
import { AnnotationToolbar } from "@/features/case-law/components/case-viewer/annotation-toolbar";
import type { AnnotationToolbarController } from "@/features/case-law/components/case-viewer/annotation-toolbar";
import { CitationHeader } from "@/features/case-law/components/case-viewer/citation-header";
import { DecisionCitations } from "@/features/case-law/components/case-viewer/decision-citations";
import type { AnnotationAnchorSource } from "@/features/case-law/components/case-viewer/decision-text";
import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import { ProvisionsCited } from "@/features/case-law/components/case-viewer/provisions-cited";
import { useDecisionCitationAnchors } from "@/features/case-law/components/case-viewer/use-decision-citation-anchors";
import { useDecisionProvisionAnchors } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import type { DecisionAnnotation } from "@/features/case-law/queries/annotations";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useCaseSearchStore } from "@/lib/case-search-store";
import { detached } from "@/lib/detached";
import type { SafeId } from "@/lib/safe-id";
import { forceReflow } from "@/lib/utils";

type DecisionWorkspaceDecision = {
  analysis?: unknown;
  caseNumber: string;
  court: string;
  decisionDate: Date | string | null;
  documentAst: unknown;
  fulltext: string | null;
  language: string;
  metadata?: Record<string, unknown> | null;
};

/** A signed-in reader's marks on the decision and the means to change them. */
export type DecisionWorkspaceAnnotations = {
  annotations: readonly DecisionAnnotation[];
  controller: AnnotationToolbarController;
};

type DecisionWorkspaceBaseProps = {
  /** Absent for a visitor: reading is public, marking needs an account. */
  annotations?: DecisionWorkspaceAnnotations | undefined;
  decision: DecisionWorkspaceDecision;
  decisionId: SafeId<"caseLawDecision">;
  initialSearchQuery?: string | undefined;
};

type LockedDecisionWorkspaceProps = DecisionWorkspaceBaseProps & {
  aiMode: "locked";
};

type EnabledDecisionWorkspaceProps = DecisionWorkspaceBaseProps & {
  aiMode: "enabled";
  ensureAIAvailable: () => Promise<boolean>;
};

export type DecisionWorkspaceProps =
  | EnabledDecisionWorkspaceProps
  | LockedDecisionWorkspaceProps;

const getHeadingDisplayAnchorId = ({
  annotations,
  startAnchorId,
}: {
  annotations: { startAnchorId: string }[];
  startAnchorId: string;
}) => annotations.at(0)?.startAnchorId ?? startAnchorId;

export const DecisionWorkspace = (props: DecisionWorkspaceProps) => {
  const { annotations, decision, decisionId, initialSearchQuery } = props;
  const t = useTranslations();
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null,
  );
  // The comment being written: its paragraphs, so the margin can sit the
  // composer beside the first and the saved comment covers them all.
  const [composing, setComposing] = useState<SelectionAnchor[] | null>(null);
  const composerItem: ComposerMarginItem[] =
    composing === null || composing[0] === undefined
      ? []
      : [
          {
            id: "composer",
            kind: "composer",
            onCancel: () => setComposing(null),
            onSubmit: (body, visibility) => {
              detached(
                annotations?.controller.create({
                  body,
                  kind: "comment",
                  spans: composing,
                  visibility,
                }) ?? Promise.resolve(),
                "case-law.annotation-comment",
              );
              setComposing(null);
            },
            startAnchorId: composing[0].blockAnchorId,
          },
        ];
  // A mark the server has not stored yet has no id to act on, so it is not
  // active even if clicked.
  const activeAnnotation =
    annotations?.annotations.find(
      (item) =>
        item.id === activeAnnotationId && !isPendingAnnotationId(item.id),
    ) ?? null;
  // A mark over several paragraphs is several rows under one group; the bar
  // acts on all of them, and a comment left from the mark covers them all.
  const rowsOf = (item: DecisionAnnotation): DecisionAnnotation[] =>
    item.groupId === null
      ? [item]
      : (annotations?.annotations ?? []).filter(
          (row) => row.groupId === item.groupId,
        );
  const activeSpans = activeAnnotation === null ? [] : rowsOf(activeAnnotation);
  // Flash the words the mark covers, the way a margin jump does, so the
  // reader sees at once what the bar is about. Runs from the id in state, so
  // the toolbar's once-installed document listener never holds a stale list.
  const activeRowIds = activeSpans.map((row) => row.id).join(" ");
  useExternalSyncEffect(() => {
    const container = mainRef.current;
    if (!container || activeRowIds === "") {
      return;
    }
    for (const id of activeRowIds.split(" ")) {
      const elements = container.querySelectorAll<HTMLElement>(
        `[data-annotation-id="${CSS.escape(id)}"]`,
      );
      for (const element of elements) {
        delete element.dataset["highlight"];
        forceReflow(element);
        element.dataset["highlight"] = "";
      }
    }
  }, [activeRowIds]);
  const annotationAnchors: AnnotationAnchorSource[] = (
    annotations?.annotations ?? []
  ).map((item) => ({
    blockAnchorId: item.blockAnchorId,
    color: item.color,
    endOffset: item.endOffset,
    id: item.id,
    kind: item.kind,
    startOffset: item.startOffset,
    style: item.style,
  }));
  // A comment over several paragraphs is several rows; its words sit on the
  // first, and that is the one the margin shows.
  const commentItems: CommentMarginItem[] = (annotations?.annotations ?? [])
    .filter((item) => item.kind === "comment" && item.body !== null)
    .map((item) => ({
      author: { image: item.authorImage, name: item.authorName },
      id: item.id,
      kind: "comment",
      mine: item.mine,
      onDelete: () => {
        detached(
          annotations?.controller.remove(item.id) ?? Promise.resolve(),
          "case-law.annotation-remove",
        );
      },
      onToggleVisibility: () => {
        detached(
          annotations?.controller.update({
            change: "visibility",
            id: item.id,
            visibility: item.visibility === "shared" ? "private" : "shared",
          }) ?? Promise.resolve(),
          "case-law.annotation-visibility",
        );
      },
      startAnchorId: item.blockAnchorId,
      text: item.body ?? "",
      visibility: item.visibility,
    }));
  const aiEnabled = props.aiMode === "enabled";
  const ensureAIAvailable =
    props.aiMode === "enabled" ? props.ensureAIAvailable : null;
  const ast = parseDocumentAst(decision.documentAst);

  const mainRef = useRef<HTMLDivElement>(null);
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
  const provisionAnchors = useDecisionProvisionAnchors(decisionId);

  const { state: analysisState, generate: generateDecisionAnalysis } =
    useDecisionAnalysis(decisionId, decision.analysis ?? null);
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
    aiEnabled &&
    (analysisState.status === "done" ||
      (analysisState.status === "generating" && analysisState.tree.length > 0));
  const isAnalyzing =
    aiEnabled &&
    analysisState.status === "generating" &&
    analysisState.tree.length === 0;
  const analysisTree = (() => {
    if (!aiEnabled) {
      return [];
    }
    if (analysisState.status === "done") {
      return analysisState.analysis.tree;
    }
    if (analysisState.status === "generating") {
      return analysisState.tree;
    }
    return [];
  })();

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

  useExternalSyncEffect(() => {
    if (aiEnabled && ast && analysisState.status === "idle") {
      detached(generate(), "decision-workspace.generate");
    }
  }, [aiEnabled, analysisState.status, ast, generate]);

  const reset = useCaseSearchStore((s) => s.reset);
  useExternalSyncEffect(() => {
    reset();
    if (initialSearchQuery) {
      setSearchQuery(initialSearchQuery);
      openSearch();
    }
  }, [decisionId, initialSearchQuery, openSearch, reset, setSearchQuery]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <h1 className="sr-only" data-slot="decision-title">
        <BidiText as="span">{decision.caseNumber}</BidiText>
      </h1>
      <div className="relative min-h-0 flex-1">
        {hasAnalysis && analysisTree.length > 0 && (
          <OutlineRail
            items={analysisOutline.items}
            onJump={(id, container) => {
              const anchorId = analysisOutline.anchorById.get(id);
              if (anchorId === undefined) {
                return;
              }
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

        <div className="reader-scroll h-full overflow-y-auto" ref={mainRef}>
          <div
            className="grid max-lg:!grid-cols-[1fr]"
            style={{ gridTemplateColumns: `${panelWidth}px minmax(0, 1fr)` }}
          >
            <aside className="relative max-lg:hidden">
              {((hasAnalysis && marginItems.length > 0) ||
                commentItems.length > 0 ||
                composerItem.length > 0) && (
                <MarginNotes
                  items={[
                    ...(hasAnalysis ? marginItems : []),
                    ...commentItems,
                    ...composerItem,
                  ]}
                  scrollContainerRef={mainRef}
                />
              )}
              {isAnalyzing && (
                <div className="px-2 pt-8">
                  <AnalysisLoader />
                </div>
              )}
              {aiEnabled && analysisState.status === "error" && (
                <div className="flex flex-col items-center gap-3 pt-12">
                  <Button
                    className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                    onClick={() => {
                      detached(generate(), "decision-workspace.generate");
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    <SparklesIcon className="size-3" />
                    {t("common.retry")}
                  </Button>
                </div>
              )}

              <div className="text-foreground-disabled sticky bottom-3 flex items-center gap-1 px-2 pt-4">
                <SparklesIcon className="size-3" />
                <span className="text-[0.6rem] font-medium tracking-wider uppercase">
                  AI
                </span>
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

            <main className="reader-paper min-w-0 px-4 py-8 max-sm:px-3">
              <CitationHeader
                decisionDate={decision.decisionDate}
                decisionId={decisionId}
              />
              <DecisionCitations decisionId={decisionId} />
              <ProvisionsCited decisionId={decisionId} />
              <DecisionText
                activeMatchIndex={activeMatchIndex}
                annotationAnchors={annotationAnchors}
                citationAnchors={citationAnchors}
                decision={decision}
                onMatchCountChange={setMatchCount}
                provisionAnchors={provisionAnchors}
                searchQuery={searchOpen ? searchQuery : ""}
                sectionMap={sectionMap}
              />
            </main>
          </div>
        </div>
        {annotations !== undefined && (
          <AnnotationToolbar
            activeAnnotation={activeAnnotation}
            activeSpans={activeSpans}
            controller={annotations.controller}
            decision={{
              caseNumber: decision.caseNumber,
              court: decision.court,
              id: decisionId,
            }}
            onActivateAnnotation={setActiveAnnotationId}
            onClearActive={() => setActiveAnnotationId(null)}
            onCompose={setComposing}
            scrollContainerRef={mainRef}
          />
        )}
      </div>
    </div>
  );
};

const AnalysisLoader = () => {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-4 px-2 pt-4">
      <div className="flex items-center gap-2">
        <Loader2Icon className="text-foreground-muted size-3.5 animate-spin" />
        <span className="text-foreground-strong-muted text-xs font-medium">
          {t("caseLaw.analyzing")}
        </span>
      </div>
      {[0.6, 0.8, 0.5, 0.7, 0.45, 0.65].map((width, index) => (
        // eslint-disable-next-line react/no-array-index-key -- static skeleton-loader placeholder widths, never reorders
        <div className="flex flex-col gap-1.5" key={index}>
          <div
            className="bg-muted/60 h-2.5 animate-pulse rounded"
            style={{
              width: `${width * 100}%`,
              animationDelay: `${index * 150}ms`,
            }}
          />
          {index % 2 === 0 && (
            <div
              className="bg-muted/30 ms-3 h-2 animate-pulse rounded"
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
