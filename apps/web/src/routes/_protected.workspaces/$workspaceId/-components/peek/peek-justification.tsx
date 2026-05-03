import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PropsWithChildren } from "react";

import { cn } from "@stll/ui/lib/utils";

import type { Citation } from "@/lib/citations";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { renderJustificationContent } from "@/lib/render-justification-content";
import type { WorkspaceJustification } from "@/lib/types";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type PeekJustificationProps = {
  justification: WorkspaceJustification;
  activeFileFieldId: string;
};

/** Renders AI justification content with kind-aware citation chips:
 *  PDF citations scroll the peek's PDF viewer to the cited page;
 *  DOCX citations queue a `scrollToBlock` on the peek's folio editor
 *  and render the cited paragraph as an inline blockquote. Both
 *  paths share the same `Citation` shape so adding a new source
 *  later (e.g. case-law decisions) only needs a new dispatch case. */
export const PeekJustification = ({
  justification,
  activeFileFieldId,
}: PeekJustificationProps) => {
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );
  const pages = usePDFStore((s) => s.pages);
  const setScrollTo = usePDFStore((s) => s.setScrollTo);
  const requestBlockScroll = useInspectorStore((s) => s.requestBlockScroll);

  // Keep a ref so the effect and click handler can read the
  // latest pages without depending on the Map reference (which
  // changes on every viewport recalculation and would cause an
  // infinite effect loop).
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  const handleCitationClick = useCallback(
    (citation: Citation) => {
      if (citation.fileFieldId !== activeFileFieldId) {
        // Cross-file jumps are out of scope for the peek — the
        // chip is rendered disabled in that case. The user can
        // open the other file manually.
        return;
      }

      if (citation.kind === "pdf-bates") {
        setActiveJustification({
          id: justification.id,
          pageNumber: citation.pageNumber,
        });
        const pageIds = [...pagesRef.current.keys()];
        const pageId = pageIds[citation.pageNumber - 1];
        if (pageId !== undefined) {
          setScrollTo({
            pageId,
            target: { kind: "justification", id: justification.id },
          });
        }
        return;
      }

      // docx-folio: queue a scroll on the active inspector tab. The
      // editor mounted there reads the queue and runs scrollToBlock.
      requestBlockScroll(activeFileFieldId, citation.blockId);
    },
    [
      activeFileFieldId,
      justification.id,
      requestBlockScroll,
      setActiveJustification,
      setScrollTo,
    ],
  );

  // Render once: keep both the node tree and the first targetable
  // citation so the auto-expand effect can use it.
  const { parsed: nodes, firstCitation } = useMemo(() => {
    const result = renderJustificationContent({
      content: justification.content,
      firstCitationFileFieldId: activeFileFieldId,
      renderCitation: ({ citation, key }) => {
        const isSameFile = citation.fileFieldId === activeFileFieldId;
        if (citation.kind === "pdf-bates") {
          return (
            <PeekPdfChip
              disabled={!isSameFile}
              key={key}
              onClick={() => handleCitationClick(citation)}
            >
              {citation.pageNumber}
            </PeekPdfChip>
          );
        }
        return (
          <PeekDocxQuote
            blockId={citation.blockId}
            disabled={!isSameFile}
            key={key}
            onClick={() => handleCitationClick(citation)}
            text={citation.text}
          />
        );
      },
    });

    return { parsed: result.nodes, firstCitation: result.firstCitation };
  }, [justification.content, activeFileFieldId, handleCitationClick]);

  // Auto-scroll to the first cited target when the peek expands so
  // the file viewer and justification stay in sync without a click.
  useEffect(() => {
    if (firstCitation === null) {
      return;
    }
    if (firstCitation.kind === "pdf-bates") {
      setActiveJustification({
        id: justification.id,
        pageNumber: firstCitation.pageNumber,
      });
      const pageIds = [...pagesRef.current.keys()];
      const pageId = pageIds[firstCitation.pageNumber - 1];
      if (pageId !== undefined) {
        setScrollTo({
          pageId,
          target: { kind: "justification", id: justification.id },
        });
      }
      return;
    }
    requestBlockScroll(firstCitation.fileFieldId, firstCitation.blockId);
  }, [
    justification.id,
    firstCitation,
    requestBlockScroll,
    setActiveJustification,
    setScrollTo,
  ]);

  // Clear active justification on unmount.
  useEffect(() => () => setActiveJustification(null), [setActiveJustification]);

  return <div>{nodes}</div>;
};

type PeekPdfChipProps = {
  disabled: boolean;
  onClick: () => void;
};

const PeekPdfChip = ({
  children,
  onClick,
  disabled,
}: PropsWithChildren<PeekPdfChipProps>) => (
  <button
    className={cn(
      "bg-muted hover:bg-accent inline-block rounded px-1.5 py-0.5 text-xs font-medium transition-colors",
      disabled && "opacity-50",
    )}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

type PeekDocxQuoteProps = {
  blockId: string;
  text: string;
  disabled: boolean;
  onClick: () => void;
};

const PeekDocxQuote = ({
  blockId,
  text,
  disabled,
  onClick,
}: PeekDocxQuoteProps) => (
  <button
    className={cn(
      "border-muted-foreground/24 hover:border-foreground/40 hover:bg-muted/40 my-1 block w-full border-s-2 ps-3 text-start text-sm italic transition-colors",
      disabled && "hover:border-s-muted cursor-not-allowed opacity-50",
    )}
    data-block-id={blockId}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    {text}
  </button>
);
