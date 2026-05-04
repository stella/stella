import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PropsWithChildren } from "react";

import { cn } from "@stll/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";

import type { Citation } from "@/lib/citations";
import { useOptionalPDFStore } from "@/lib/pdf/pdf-context";
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
  // PDF store is only mounted when the viewer is in scope (e.g. peek
  // mode); the metadata panel can also render in a full-view lane
  // where no peek viewer exists. Fall back to undefined and let the
  // route URL drive bbox highlighting via setActiveJustification.
  const pages = useOptionalPDFStore((s) => s.pages);
  const setScrollTo = useOptionalPDFStore((s) => s.setScrollTo);
  const requestBlockScroll = useInspectorStore((s) => s.requestBlockScroll);
  // Used to push `justificationPage` into the route's URL so the
  // document route's JustificationScrollSync can move the viewer.
  const navigate = useNavigate();

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
        // Update the route's `?justificationPage=` so the document
        // route's JustificationScrollSync drives the full-view PDF.
        // Falls back to no-op if no router context is available.
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        void navigate({
          replace: true,
          search: (prev) => ({
            ...prev,
            justificationPage: citation.pageNumber,
          }),
        } as Parameters<typeof navigate>[0]);
        if (pagesRef.current && setScrollTo) {
          const pageIds = [...pagesRef.current.keys()];
          const pageId = pageIds[citation.pageNumber - 1];
          if (pageId !== undefined) {
            setScrollTo({
              pageId,
              target: { kind: "justification", id: justification.id },
            });
          }
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
      navigate,
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
      if (pagesRef.current && setScrollTo) {
        const pageIds = [...pagesRef.current.keys()];
        const pageId = pageIds[firstCitation.pageNumber - 1];
        if (pageId !== undefined) {
          setScrollTo({
            pageId,
            target: { kind: "justification", id: justification.id },
          });
        }
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

const CITATION_CHIP_CLASSES =
  "bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center align-baseline rounded-md px-1.5 py-0.5 text-[11px] font-medium not-italic transition-colors";

const PeekPdfChip = ({
  children,
  onClick,
  disabled,
}: PropsWithChildren<PeekPdfChipProps>) => (
  <button
    className={cn(
      CITATION_CHIP_CLASSES,
      disabled && "cursor-not-allowed opacity-40",
    )}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    p.&nbsp;{children}
  </button>
);

const DOCX_CHIP_PREVIEW_CHARS = 32;

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
}: PeekDocxQuoteProps) => {
  const trimmed = text.trim();
  const preview =
    trimmed.length > DOCX_CHIP_PREVIEW_CHARS
      ? `${trimmed.slice(0, DOCX_CHIP_PREVIEW_CHARS).trimEnd()}…`
      : trimmed || "¶";
  return (
    <button
      className={cn(
        CITATION_CHIP_CLASSES,
        "max-w-[16rem] truncate",
        disabled && "cursor-not-allowed opacity-40",
      )}
      data-block-id={blockId}
      disabled={disabled}
      onClick={onClick}
      title={trimmed || undefined}
      type="button"
    >
      “{preview}”
    </button>
  );
};
