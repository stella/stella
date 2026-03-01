import type { PropsWithChildren } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import parse, { domToReact, Element, type DOMNode } from "html-react-parser";
import { produce } from "immer";

import { cn } from "@stella/ui/lib/utils";

import { usePdfStore } from "@/lib/pdf/pdf-store";
import type { WorkspaceJustification } from "@/lib/types";
import { useCreateBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-b-boxes";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type JustificationProps = {
  justification: WorkspaceJustification;
};

export const Justification = ({ justification }: JustificationProps) => {
  return (
    <p>
      {parse(justification.htmlContent, {
        replace: (node) => {
          if (!(node instanceof Element)) {
            return node;
          }

          const pageNumberAttribute = node.attribs["data-page-number"];
          const fileFieldId = node.attribs["data-field-id"];

          if (!pageNumberAttribute || !fileFieldId) {
            return node;
          }

          const pageNumber = +pageNumberAttribute;

          if (Number.isNaN(pageNumber)) {
            return node;
          }

          return (
            <Citation
              fileFieldId={fileFieldId}
              justification={justification}
              pageNumber={pageNumber}
            >
              {domToReact(node.children as DOMNode[])}
            </Citation>
          );
        },
      })}
    </p>
  );
};

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
  const currentJustification = useSearch({
    from: "/_protected/workspaces/$workspaceId/pdf",
    select: (s) => s.justification,
  });

  const isActive =
    justification?.id === currentJustification?.id &&
    pageNumber === currentJustification?.pageNumber;
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/pdf",
  });
  const createBoundingBoxes = useCreateBBoxes({
    justification,
  });
  const setScrollTo = usePdfStore((s) => s.setScrollTo);

  return (
    <button
      className={cn(
        "inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-accent",
        isActive && "bg-accent hover:bg-accent",
      )}
      onClick={async () => {
        createBoundingBoxes();

        const boundingBoxes = useWorkspaceStore
          .getState()
          .justifications.find((j) => j.id === justification.id)?.boundingBoxes;

        setScrollTo(fileFieldId, {
          pageNumber,
          justificationId: boundingBoxes ? justification.id : undefined,
        });
        await navigate({
          replace: true,
          search: (prev) =>
            produce(prev, (s) => {
              s.file.fieldId = fileFieldId;
              s.file.pageNumber = pageNumber;
              s.justification = {
                id: justification.id,
                pageNumber,
              };
            }),
        });
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
