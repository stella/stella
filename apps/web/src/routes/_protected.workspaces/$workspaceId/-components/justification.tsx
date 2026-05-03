import { cn } from "@stll/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { useShallow } from "zustand/react/shallow";

import type { Citation } from "@/lib/citations";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { renderJustificationContent } from "@/lib/render-justification-content";
import type { WorkspaceJustification } from "@/lib/types";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { useCreateBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-b-boxes";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

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
  const [pages, setScrollTo] = usePDFStore(
    useShallow((s) => [s.pages, s.setScrollTo]),
  );

  return (
    <button
      className={cn(
        "bg-muted hover:bg-accent inline-block rounded px-1.5 py-0.5 text-xs font-medium transition-colors",
        isActive && "bg-accent hover:bg-accent",
      )}
      // eslint-disable-next-line typescript/no-misused-promises
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
          const pageIds = [...pages.keys()];
          const pageId = pageIds[citation.pageNumber - 1];

          if (pageId !== undefined) {
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
      {citation.pageNumber}
    </button>
  );
};

type DocxQuoteProps = {
  citation: Extract<Citation, { kind: "docx-folio" }>;
};

const DocxQuote = ({ citation }: DocxQuoteProps) => {
  const requestBlockScroll = useInspectorStore((s) => s.requestBlockScroll);
  return (
    <button
      className={cn(
        "border-muted-foreground/24 hover:border-foreground/40 hover:bg-muted/40 my-1 block w-full border-s-2 ps-3 text-start text-sm italic transition-colors",
      )}
      data-block-id={citation.blockId}
      onClick={() => requestBlockScroll(citation.fileFieldId, citation.blockId)}
      type="button"
    >
      {citation.text}
    </button>
  );
};
