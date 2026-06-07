import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { Button } from "@stll/ui/components/button";
import { OutlineRail } from "@stll/ui/components/outline-rail";
import type { OutlineItem } from "@stll/ui/components/outline-rail";

import { MarginNotes } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import {
  buildSectionMap,
  flattenAnalysisHeadings,
  getCategoryVar,
} from "@/features/case-law/components/case-viewer/analysis/types";
import { useDecisionAnalysis } from "@/features/case-law/components/case-viewer/analysis/use-decision-analysis";
import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import { useCaseSearchStore } from "@/lib/case-search-store";
import type { SafeId } from "@/lib/safe-id";

type DecisionWorkspaceDecision = {
  analysis?: unknown;
  caseNumber: string;
  court: string;
  documentAst: unknown;
  fulltext: string | null;
  language: string;
  metadata?: Record<string, unknown> | null;
};

type DecisionWorkspaceBaseProps = {
  decision: DecisionWorkspaceDecision;
  decisionId: SafeId<"caseLawDecision">;
  initialSearchQuery?: string | undefined;
};

type LockedDecisionWorkspaceProps = DecisionWorkspaceBaseProps & {
  aiMode: "locked";
  publicPath: string;
  requestAuth: (redirectTo: string) => void;
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

export function DecisionWorkspace(props: DecisionWorkspaceProps) {
  const { decision, decisionId, initialSearchQuery } = props;
  const t = useTranslations();
  const aiEnabled = props.aiMode === "enabled";
  const ensureAIAvailable =
    props.aiMode === "enabled" ? props.ensureAIAvailable : null;
  const publicPath = props.aiMode === "locked" ? props.publicPath : undefined;
  const requestAuth = props.aiMode === "locked" ? props.requestAuth : undefined;
  const ast = useMemo(
    () => parseDocumentAst(decision.documentAst),
    [decision.documentAst],
  );

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
  const analysisTree = useMemo(() => {
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
  }, [aiEnabled, analysisState]);

  const sectionMap = useMemo(() => {
    if (analysisTree.length === 0 || !ast) {
      return undefined;
    }
    const anchorIds = ast.blocks.map((b) => b.anchorId);
    return buildSectionMap(analysisTree, anchorIds);
  }, [analysisTree, ast]);

  const flatAnalysisHeadings = useMemo(
    () => flattenAnalysisHeadings(analysisTree),
    [analysisTree],
  );

  // Analysis outline for the shared rail: category colours + display anchors.
  const analysisOutline = useMemo(() => {
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
  }, [flatAnalysisHeadings]);

  const marginItems = useMemo(
    () =>
      flatAnalysisHeadings.flatMap((heading) => {
        type Item = {
          kind: "card" | "annotation";
          id: string;
          heading?: string;
          text: string;
          category: string;
          depth: number;
          startAnchorId: string;
        };

        const items: Item[] = [];
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
      }),
    [flatAnalysisHeadings],
  );

  useEffect(() => {
    if (aiEnabled && ast && analysisState.status === "idle") {
      void generate();
    }
  }, [aiEnabled, analysisState.status, ast, generate]);

  const reset = useCaseSearchStore((s) => s.reset);
  useEffect(() => {
    reset();
    if (initialSearchQuery) {
      setSearchQuery(initialSearchQuery);
      openSearch();
    }
  }, [decisionId, initialSearchQuery, openSearch, reset, setSearchQuery]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div>
          <p className="text-muted-foreground text-xs">{decision.court}</p>
          <h1 className="text-xl font-semibold">{decision.caseNumber}</h1>
        </div>
        {aiEnabled ? (
          <Button
            onClick={() => {
              void generate();
            }}
            size="sm"
            variant="outline"
          >
            <SparklesIcon className="size-4" />
            {t("ai.analyzeWithAI")}
          </Button>
        ) : (
          <Button
            onClick={() => requestAuth?.(publicPath ?? "/law/cases")}
            size="sm"
          >
            <SparklesIcon className="size-4" />
            {t("ai.analyzeWithAI")}
          </Button>
        )}
      </header>
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
              void el.offsetWidth;
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
              {hasAnalysis && marginItems.length > 0 && (
                <MarginNotes items={marginItems} scrollContainerRef={mainRef} />
              )}
              {isAnalyzing && (
                <div className="px-2 pt-8">
                  <AnalysisLoader />
                </div>
              )}
              {aiEnabled && analysisState.status === "error" && (
                <div className="flex flex-col items-center gap-3 pt-12">
                  <button
                    className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                    onClick={() => {
                      void generate();
                    }}
                    type="button"
                  >
                    <SparklesIcon className="size-3" />
                    {t("common.retry")}
                  </button>
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
              <DecisionText
                activeMatchIndex={activeMatchIndex}
                decision={decision}
                onMatchCountChange={setMatchCount}
                searchQuery={searchOpen ? searchQuery : ""}
                sectionMap={sectionMap}
              />
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnalysisLoader() {
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
}
