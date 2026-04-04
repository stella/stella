import { useEffect, useMemo, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2Icon, SparklesIcon } from "lucide-react";

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
const extractId = (param: string): string => {
  const sep = param.lastIndexOf("--");
  return sep !== -1 ? param.slice(sep + 2) : param;
};

export const Route = createFileRoute("/_protected/knowledge/case/$decisionId")({
  loader: async ({ context: { queryClient }, params: { decisionId } }) =>
    await queryClient.ensureQueryData(decisionOptions(extractId(decisionId))),
  component: DecisionViewer,
});

type AstBlock = {
  type: string;
  anchorId: string;
  level?: number;
  plainText: string;
  role?: string;
};

type DocumentAst = {
  blocks: AstBlock[];
};

const isDocumentAst = (val: unknown): val is DocumentAst =>
  typeof val === "object" &&
  val !== null &&
  "blocks" in val &&
  // SAFETY: `"blocks" in val` narrows val; Record cast reads it.
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  Array.isArray((val as Record<string, unknown>).blocks);

const parseDocumentAst = (raw: unknown): DocumentAst | null => {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "string") {
    const parsed: unknown = JSON.parse(raw);
    return isDocumentAst(parsed) ? parsed : null;
  }
  return isDocumentAst(raw) ? raw : null;
};

function DecisionViewer() {
  const rawParam = Route.useParams({ select: (p) => p.decisionId });
  const decisionId = extractId(rawParam);
  const { data: decision } = useSuspenseQuery(decisionOptions(decisionId));

  const ast = useMemo(
    () => parseDocumentAst(decision.documentAst),
    [decision.documentAst],
  );

  // Set document title to case number
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

  // ── AI analysis ───────────────────────────────────────────

  const { state: analysisState, generate } = useDecisionAnalysis(
    decisionId,
    decision.analysis,
  );

  const hasAnalysis =
    analysisState.status === "done" ||
    (analysisState.status === "generating" && analysisState.tree.length > 0);
  const isAnalyzing =
    analysisState.status === "generating" && analysisState.tree.length === 0;
  const analysisTree =
    analysisState.status === "done"
      ? analysisState.analysis.tree
      : analysisState.status === "generating"
        ? analysisState.tree
        : [];

  const sectionMap = useMemo(() => {
    if (analysisTree.length === 0 || !ast) return undefined;
    const anchorIds = ast.blocks.map((b) => b.anchorId);
    return buildSectionMap(analysisTree, anchorIds);
  }, [ast, analysisTree]);

  const marginItems = useMemo(
    () =>
      analysisTree.flatMap((h) => {
        type Item = {
          kind: "card" | "annotation";
          id: string;
          heading?: string;
          text: string;
          category: string;
          startAnchorId: string;
        };
        const items: Item[] = [];

        const first = h.annotations.at(0);
        if (first) {
          // Merge heading + first annotation into one card
          items.push({
            kind: "card",
            id: first.id,
            heading: h.label,
            text: first.summary,
            category: h.category,
            startAnchorId: first.startAnchorId,
          });
          // Remaining annotations as standalone
          for (const a of h.annotations.slice(1)) {
            items.push({
              kind: "annotation",
              id: a.id,
              text: a.summary,
              category: h.category,
              startAnchorId: a.startAnchorId,
            });
          }
        } else {
          // Heading-only (no annotations)
          items.push({
            kind: "card",
            id: `h-${h.id}`,
            heading: h.label,
            text: "",
            category: h.category,
            startAnchorId: h.startAnchorId,
          });
        }

        return items;
      }),
    [analysisTree],
  );

  // Auto-trigger generation when the decision has an AST but no analysis
  useEffect(() => {
    if (ast && analysisState.status === "idle") {
      generate();
    }
  }, [ast, analysisState.status, generate]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Scroll area wrapper (relative for overlay markers) ── */}
      <div className="relative min-h-0 flex-1">
        {/* Scrollbar heading markers (overlaid, not scrolling) */}
        {hasAnalysis && analysisTree.length > 0 && (
          <ScrollMarkers
            headings={analysisTree.map((h) => ({
              id: h.id,
              label: h.label,
              startAnchorId: h.startAnchorId,
              category: h.category,
            }))}
            scrollContainerRef={mainRef}
          />
        )}

        {/* ── Scrollable content ────────────────────────────── */}
        <div
          className="reader-scroll h-full overflow-y-auto"
          ref={mainRef}
        >

        <div
          className="grid max-lg:!grid-cols-[1fr]"
          style={{ gridTemplateColumns: `${panelWidth}px minmax(0, 1fr)` }}
        >
          {/* Left: margin notes with resize handle */}
          <aside className="relative max-lg:hidden">
            {hasAnalysis && marginItems.length > 0 && (
              <MarginNotes
                items={marginItems}
                scrollContainerRef={mainRef}
              />
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

            {/* AI label */}
            <div className="text-muted-foreground/40 sticky bottom-3 flex items-center gap-1 px-2 pt-4">
              <SparklesIcon className="size-3" />
              <span className="text-[0.6rem] font-medium tracking-wider uppercase">AI</span>
            </div>

            {/* Resize handle with grip dots */}
            <div
              className="group hover:bg-border/50 active:bg-border absolute inset-y-0 -right-px z-10 flex w-2 cursor-col-resize items-center justify-center"
              onPointerDown={(e) => {
                e.preventDefault();
                isDragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!isDragging.current) return;
                const aside = e.currentTarget.parentElement;
                if (!aside) return;
                const newWidth = e.clientX - aside.getBoundingClientRect().left;
                setPanelWidth(Math.min(400, Math.max(120, newWidth)));
              }}
              onPointerUp={() => {
                isDragging.current = false;
              }}
            >
              {/* iOS-style grip dots */}
              <div className="flex flex-col gap-[3px] opacity-0 transition-opacity group-hover:opacity-40">
                <div className="bg-foreground h-[3px] w-[3px] rounded-full" />
                <div className="bg-foreground h-[3px] w-[3px] rounded-full" />
                <div className="bg-foreground h-[3px] w-[3px] rounded-full" />
              </div>
            </div>
          </aside>

          {/* Decision text */}
          <main className="reader-paper min-w-0 px-4 py-8 max-sm:px-3">
            <DecisionText decision={decision} sectionMap={sectionMap} />
          </main>
        </div>

        </div>
      </div>
    </div>
  );
}

/** Skeleton loader shown in the left sidebar while analysis generates. */
function AnalysisLoader() {
  return (
    <div className="flex flex-col gap-4 px-2 pt-4">
      <div className="flex items-center gap-2">
        <Loader2Icon className="text-muted-foreground/60 size-3.5 animate-spin" />
        <span className="text-muted-foreground/80 text-xs font-medium">
          Analyzing...
        </span>
      </div>
      {/* Skeleton heading lines */}
      {[0.6, 0.8, 0.5, 0.7, 0.45, 0.65].map((w, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div
            className="bg-muted/60 h-2.5 animate-pulse rounded"
            style={{ width: `${w * 100}%`, animationDelay: `${i * 150}ms` }}
          />
          {i % 2 === 0 && (
            <div
              className="bg-muted/30 ml-3 h-2 animate-pulse rounded"
              style={{
                width: `${w * 70}%`,
                animationDelay: `${i * 150 + 75}ms`,
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
