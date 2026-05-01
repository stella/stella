import type { PropsWithChildren } from "react";

import { cn } from "@stll/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { useShallow } from "zustand/react/shallow";

import { usePDFStore } from "@/lib/pdf/pdf-context";
import { renderJustificationContent } from "@/lib/render-justification-content";
import type { WorkspaceJustification } from "@/lib/types";
import { useCreateBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-b-boxes";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type JustificationProps = {
  justification: WorkspaceJustification;
};

export const Justification = ({ justification }: JustificationProps) => (
  <div>
    {
      renderJustificationContent({
        content: justification.content,
        renderCitation: ({ children, fileFieldId, key, pageNumber }) => (
          <Citation
            fileFieldId={fileFieldId}
            justification={justification}
            key={key}
            pageNumber={pageNumber}
          >
            {children}
          </Citation>
        ),
      }).nodes
    }
  </div>
);

type CitationProps = {
  justification: WorkspaceJustification;
  pageNumber: number;
  fileFieldId: string;
};

const Citation = ({
  justification,
  pageNumber,
  fileFieldId,
  children,
}: PropsWithChildren<CitationProps>) => {
  const currentJustification = useWorkspaceStore((s) => s.activeJustification);
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );

  const isActive =
    justification?.id === currentJustification?.id &&
    pageNumber === currentJustification?.pageNumber;
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });
  const createBoundingBoxes = useCreateBBoxes({
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
            pageNumber,
          });

          const boundingBoxes = useWorkspaceStore
            .getState()
            .justifications.find(
              (j) => j.id === justification.id,
            )?.boundingBoxes;
          const pageIds = [...pages.keys()];
          const pageId = pageIds[pageNumber - 1];

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
                s.field = fileFieldId;
                s.justification = justification.id;
                s.justificationPage = pageNumber;
                s.pdfPage = pageNumber;
              }),
          });
        })();
      }}
      onMouseEnter={() => {
        createBoundingBoxes();
      }}
      type="button"
    >
      {children}
    </button>
  );
};
