import { useEffect, useMemo, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { parseDocumentAst } from "@stella/case-law/document-ast";

import { useCaseSearchStore } from "@/lib/case-search-store";
import { ensureCriticalQueryData } from "@/lib/react-query";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { MarginNotes } from "@/routes/_protected.knowledge/case/-components/case-viewer/analysis/margin-notes";
import { ScrollMarkers } from "@/routes/_protected.knowledge/case/-components/case-viewer/analysis/scroll-markers";
import { buildSectionMap } from "@/routes/_protected.knowledge/case/-components/case-viewer/analysis/types";
import { useDecisionAnalysis } from "@/routes/_protected.knowledge/case/-components/case-viewer/analysis/use-decision-analysis";
import { DecisionText } from "@/routes/_protected.knowledge/case/-components/case-viewer/decision-text";
import { decisionOptions } from "@/routes/_protected.knowledge/case/-queries/decisions";

/**
 * Extract the ID from a composite URL param.
 * Format: "case-slug--id" or just "id" (legacy).
 */
const extractId = (param: string): SafeId<"caseLawDecision"> => {
  const sep = param.lastIndexOf("--");
  return toSafeId<"caseLawDecision">(sep !== -1 ? param.slice(sep + 2) : param);
};

export const Route = createFileRoute("/_protected/knowledge/case/$decisionId")({
  loader: async ({ context: { queryClient }, params: { decisionId } }) =>
    await ensureCriticalQueryData(
      queryClient,
      decisionOptions(extractId(decisionId)),
    ),
  component: DecisionViewer,
});

function DecisionViewer() {
  const rawParam = Route.useParams({ select: (p) => p.decisionId });
  const decisionId = extractId(rawParam);
  const { data: decision } = useSuspenseQuery(decisionOptions(decisionId));

  const ast = useMemo(
    () => parseDocumentAst(decision.documentAst),
    [decision.documentAst],
  );

  useEffect(() => {
    const prev = document.title;
    document.title = `${decision.caseNumber} | stella`;
    return () => {
      document.title = prev;
    };
  }, [decision.caseNumber]);

  const mainRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(220);
  const isDragging = useRef(false);
  const { searchOpen, searchQuery, activeMatchIndex, setMatchCount } =
    useCaseSearchStore(
      useShallow((s) => ({
        searchOpen: s.isOpen,
        searchQuery: s.query,
        activeMatchIndex: s.activeMatchIndex,
        setMatchCount: s.setMatchCount,
      })),
    );

  const { state: analysisState, generate } = useDecisionAnalysis(
    decisionId,
    decision.analysis,
  );

  const hasAnalysis =
    analysisState.status === "done" ||
    (analysisState.status === "generating" && analysisState.tree.length > 0);
  const isAnalyzing =
    analysisState.status === "generating" && analysisState.tree.length === 0;
  const analysisTree = useMemo(() => {
    if (analysisState.status === "done") {
      return analysisState.analysis.tree;
    }
    if (analysisState.status === "generating") {
      return analysisState.tree;
    }
    return [];
  }, [analysisState]);

  const sectionMap = useMemo(() => {
    if (analysisTree.length === 0 || !ast) {
      return undefined;
    }
    const anchorIds = ast.blocks.map((b) => b.anchorId);
    return buildSectionMap(analysisTree, anchorIds);
  }, [analysisTree, ast]);

  const marginItems = useMemo(
    () =>
      analysisTree.flatMap((heading) => {
        type Item = {
          kind: "card" | "annotation";
          id: string;
          heading?: string;
          text: string;
          category: string;
          startAnchorId: string;
        };

        const items: Item[] = [];
        const first = heading.annotations.at(0);

        if (first) {
          items.push({
            kind: "card",
            id: first.id,
            heading: heading.label,
            text: first.summary,
            category: heading.category,
            startAnchorId: first.startAnchorId,
          });

          for (const annotation of heading.annotations.slice(1)) {
            items.push({
              kind: "annotation",
              id: annotation.id,
              text: annotation.summary,
              category: heading.category,
              startAnchorId: annotation.startAnchorId,
            });
          }

          return items;
        }

        return items;
      }),
    [analysisTree],
  );

  useEffect(() => {
    if (ast && analysisState.status === "idle") {
      void generate();
    }
  }, [analysisState.status, ast, generate]);

  // Reset search state on decision change so the header toolbar
  // is closed and matches from the previous decision are cleared.
  const reset = useCaseSearchStore((s) => s.reset);
  useEffect(() => {
    reset();
  }, [decisionId, reset]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        {hasAnalysis && analysisTree.length > 0 && (
          <ScrollMarkers
            headings={analysisTree.map((heading) => ({
              id: heading.id,
              label: heading.label,
              startAnchorId: heading.startAnchorId,
              category: heading.category,
            }))}
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
              {analysisState.status === "error" && (
                <div className="flex flex-col items-center gap-3 pt-12">
                  <button
                    className="text-muted-foreground hover:text-foreground hover:bg-muted flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                    onClick={generate}
                    type="button"
                  >
                    <SparklesIcon className="size-3" />
                    Retry
                  </button>
                </div>
              )}

              <div className="text-muted-foreground/40 sticky bottom-3 flex items-center gap-1 px-2 pt-4">
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
  return (
    <div className="flex flex-col gap-4 px-2 pt-4">
      <div className="flex items-center gap-2">
        <Loader2Icon className="text-muted-foreground/60 size-3.5 animate-spin" />
        <span className="text-muted-foreground/80 text-xs font-medium">
          Analyzing...
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
