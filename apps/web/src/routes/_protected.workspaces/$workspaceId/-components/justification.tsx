import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";

import { cn } from "@stll/ui/lib/utils";

import type { Citation } from "@/lib/citations";
import {
  getPDFPageIdByNumber,
  useOptionalPDFStore,
} from "@/lib/pdf/pdf-context";
import { renderJustificationContent } from "@/lib/render-justification-content";
import type { WorkspaceJustification } from "@/lib/types";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useCreateBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-b-boxes";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const CITATION_CHIP_CLASSES =
  "bg-primary/10 text-primary hover:bg-primary/20 inline-flex items-center align-baseline rounded-md px-1.5 py-0.5 text-[11px] font-medium not-italic transition-colors";

const DOCX_CHIP_PREVIEW_CHARS = 32;

type JustificationProps = {
  workspaceId: string;
  justification: WorkspaceJustification;
};

export const Justification = ({
  workspaceId,
  justification,
}: JustificationProps) => (
  <div>
    {
      renderJustificationContent({
        content: justification.content,
        renderCitation: ({ citation, key }) => {
          if (citation.kind === "pdf-bates") {
            return (
              <PdfChip
                citation={citation}
                justification={justification}
                key={key}
                workspaceId={workspaceId}
              />
            );
          }
          return <DocxQuote citation={citation} key={key} />;
        },
      }).nodes
    }
  </div>
);

type PdfChipProps = {
  workspaceId: string;
  justification: WorkspaceJustification;
  citation: Extract<Citation, { kind: "pdf-bates" }>;
};

const PdfChip = ({ workspaceId, justification, citation }: PdfChipProps) => {
  const currentJustification = useWorkspaceStore((s) => s.activeJustification);
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );

  const isActive =
    justification.id === currentJustification?.id &&
    citation.pageNumber === currentJustification.pageNumber;
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/document",
  });
  const createBoundingBoxes = useCreateBBoxes({
    workspaceId,
    justification,
  });
  // The metadata panel can render in a full-view lane that sits
  // outside the route's PDFProvider; fall back to URL-driven scroll
  // (handled by JustificationScrollSync inside the route's provider).
  const pageId = useOptionalPDFStore((s) =>
    getPDFPageIdByNumber({
      fieldId: s.fieldId,
      pages: s.pages,
      pageNumber: citation.pageNumber,
    }),
  );
  const pdfFieldId = useOptionalPDFStore((s) => s.fieldId);
  const setScrollTo = useOptionalPDFStore((s) => s.setScrollTo);

  return (
    <button
      className={cn(
        CITATION_CHIP_CLASSES,
        isActive && "bg-primary/25 hover:bg-primary/25",
      )}
      onClick={() => {
        void (async () => {
          createBoundingBoxes();
          setActiveJustification({
            id: justification.id,
            pageNumber: citation.pageNumber,
          });

          const boundingBoxes = useWorkspaceStore
            .getState()
            .justifications.find(
              (j) => j.id === justification.id,
            )?.boundingBoxes;
          if (pdfFieldId === citation.fileFieldId && pageId && setScrollTo) {
            setScrollTo({
              pageId,
              target: boundingBoxes
                ? { kind: "justification", id: justification.id }
                : undefined,
            });
          }
          await navigate({
            replace: true,
            search: (prev) =>
              produce(prev, (s) => {
                s.field = citation.fileFieldId;
                s.justification = justification.id;
                s.justificationPage = citation.pageNumber;
                s.pdfPage = citation.pageNumber;
              }),
          });
        })();
      }}
      onMouseEnter={() => {
        createBoundingBoxes();
      }}
      type="button"
    >
      p.&nbsp;{citation.pageNumber}
    </button>
  );
};

type DocxQuoteProps = {
  citation: Extract<Citation, { kind: "docx-folio" }>;
};

const DocxQuote = ({ citation }: DocxQuoteProps) => {
  const requestBlockScroll = useInspectorStore((s) => s.requestBlockScroll);
  const trimmed = citation.text.trim();
  const preview =
    trimmed.length > DOCX_CHIP_PREVIEW_CHARS
      ? `${trimmed.slice(0, DOCX_CHIP_PREVIEW_CHARS).trimEnd()}…`
      : trimmed || "¶";
  return (
    <button
      className={cn(CITATION_CHIP_CLASSES, "max-w-[16rem] truncate")}
      data-block-id={citation.blockId}
      onClick={() => {
        // Inspector peek path reads `pendingBlockScroll` from the
        // store; the full-view DocxBrowserEditor listens for the
        // window event (see docx-browser-editor.tsx). Fire both so
        // both surfaces respond.
        requestBlockScroll(citation.fileFieldId, citation.blockId);
        window.dispatchEvent(
          new CustomEvent<{ blockId: string }>("folio:scroll-to-block", {
            detail: { blockId: citation.blockId },
          }),
        );
      }}
      title={trimmed || undefined}
      type="button"
    >
      “{preview}”
    </button>
  );
};
