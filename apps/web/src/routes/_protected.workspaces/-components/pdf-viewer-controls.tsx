import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { produce } from "immer";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";

import Tooltip from "@/components/tooltip";
import { DOCX_MIME } from "@/lib/consts";
import { fileMetadataOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import {
  PeekPdfControls,
  PreparedPdfPrintButton,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const SCALE_OFFSET_STEP = 0.2;

export const PdfViewerControls = () => {
  const t = useTranslations();
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (params) => params.workspaceId,
  });
  const { field: fieldId = "", pdfPage: currentPage = 1 } = useSearch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (s) => ({ field: s.field, pdfPage: s.pdfPage }),
  });
  const editing = useSearch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (s) => s.editing === true,
  });
  const { data: fileMetadata } = useQuery({
    ...fileMetadataOptions({ workspaceId, fieldId }),
    enabled: fieldId.length > 0,
  });

  const totalPages = useWorkspaceStore((s) => s.pdfPageCount);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const setPdfScaleOffset = useWorkspaceStore((s) => s.setPdfScaleOffset);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const pageInputValue = editingPage ?? currentPage;
  const isDocx =
    fileMetadata?.originalMimeType === DOCX_MIME ||
    fileMetadata?.mimeType === DOCX_MIME;
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });

  const navigateToScale = (offset: number) => {
    setPdfScaleOffset(Math.round(offset * 10) / 10);
  };

  const navigateToPage = (pageNumber: number) => {
    // eslint-disable-next-line typescript/no-floating-promises
    navigate({
      replace: true,
      search: (prev) =>
        produce(prev, (s) => {
          s.pdfPage = pageNumber;
        }),
    });
  };

  if (editing) {
    return null;
  }

  return (
    <div className="ms-auto flex items-center gap-1">
      <div className="flex items-center rounded-md border p-0.5">
        <PeekPdfControls
          canResetZoom={scaleOffset !== 0}
          onResetZoom={() => navigateToScale(0)}
          onZoomIn={
            scaleOffset >= 2
              ? undefined
              : () => navigateToScale(scaleOffset + SCALE_OFFSET_STEP)
          }
          onZoomOut={
            scaleOffset <= -0.8
              ? undefined
              : () => navigateToScale(scaleOffset - SCALE_OFFSET_STEP)
          }
          scaleOffset={scaleOffset}
        />
      </div>
      <PreparedPdfPrintButton
        disabled={fieldId.length === 0}
        fieldId={fieldId}
        workspaceId={workspaceId}
      />
      {!isDocx && (
        <>
          <Separator className="mx-1 h-4" orientation="vertical" />
          <Tooltip
            content={t("workspaces.pdf.previousPage")}
            render={
              <Button
                disabled={currentPage <= 1}
                onClick={() => {
                  setEditingPage(null);
                  navigateToPage(currentPage - 1);
                }}
                size="icon-xs"
                variant="ghost"
              >
                <ChevronUpIcon className="size-3.5" />
              </Button>
            }
          />
          <Tooltip
            content={t("workspaces.pdf.nextPage")}
            render={
              <Button
                disabled={currentPage >= totalPages}
                onClick={() => {
                  setEditingPage(null);
                  navigateToPage(currentPage + 1);
                }}
                size="icon-xs"
                variant="ghost"
              >
                <ChevronDownIcon className="size-3.5" />
              </Button>
            }
          />
          <div className="ms-1.5 me-2 flex gap-x-1.5 text-sm">
            <input
              aria-label={t("common.currentPage")}
              autoComplete="off"
              className="me-1 w-14 rounded border px-1 text-end"
              inputMode="numeric"
              onBlur={() => {
                if (
                  editingPage !== null &&
                  editingPage >= 1 &&
                  editingPage <= totalPages
                ) {
                  navigateToPage(editingPage);
                }
                setEditingPage(null);
              }}
              onChange={(e) => {
                const value = +e.target.value;
                if (Number.isNaN(value)) {
                  return;
                }
                setEditingPage(value);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") {
                  return;
                }
                e.currentTarget.blur();
              }}
              value={pageInputValue}
            />
            <span>/</span>
            <span>{totalPages}</span>
          </div>
        </>
      )}
    </div>
  );
};
