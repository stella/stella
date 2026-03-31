import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronUpIcon } from "lucide-react";

import { DecisionText } from "@/routes/_protected.knowledge/case-law/-components/case-viewer/decision-text";
import { SectionToc } from "@/routes/_protected.knowledge/case-law/-components/case-viewer/section-toc";
import { decisionOptions } from "@/routes/_protected.knowledge/case-law/-queries/decisions";

/**
 * Extract the nanoid from a composite URL param.
 * Format: "case-slug--nanoid" or just "nanoid" (legacy).
 */
const extractId = (param: string): string => {
  const sep = param.lastIndexOf("--");
  return sep !== -1 ? param.slice(sep + 2) : param;
};

export const Route = createFileRoute(
  "/_protected/knowledge/case-law/$decisionId",
)({
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
  const { decisionId: rawParam } = Route.useParams();
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

  const tocEntries = useMemo(() => {
    if (!ast) {
      return [];
    }
    return ast.blocks
      .filter((b): b is AstBlock & { type: "heading" } => b.type === "heading")
      .map((b) => ({
        anchorId: b.anchorId,
        label: b.plainText,
        level: b.level ?? 1,
      }));
  }, [ast]);

  const mainRef = useRef<HTMLElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      setShowScrollTop(el.scrollTop > 400);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = useCallback(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <div className="grid h-full grid-cols-[minmax(180px,240px)_minmax(0,1fr)] items-start overflow-hidden max-lg:grid-cols-[1fr]">
      <aside className="text-muted-foreground flex h-full flex-col overflow-y-auto px-3 py-6 max-lg:hidden">
        {tocEntries.length > 0 && <SectionToc entries={tocEntries} />}
        {showScrollTop && (
          <button
            className="hover:bg-muted mt-auto flex size-8 items-center justify-center self-center rounded-full transition-colors"
            onClick={scrollToTop}
            type="button"
          >
            <ChevronUpIcon className="size-4" />
          </button>
        )}
      </aside>

      <main
        className="bg-card relative h-full min-w-0 overflow-y-auto px-10 py-8 max-sm:px-4"
        ref={mainRef}
      >
        <DecisionText decision={decision} />
      </main>
    </div>
  );
}
