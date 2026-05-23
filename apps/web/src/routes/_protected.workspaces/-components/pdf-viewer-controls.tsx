import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  PrinterIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Separator } from "@stll/ui/components/separator";
import { stellaToast } from "@stll/ui/components/toast";

import Tooltip from "@/components/tooltip";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { ClientOperationError, toAPIError } from "@/lib/errors";
import { fileMetadataOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import {
  fetchPrintPdf,
  PeekPdfControls,
  printPdfBuffer,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const SCALE_OFFSET_STEP = 0.2;

type PdfViewerControlsProps = {
  workspaceId: string;
  fieldId: string;
  currentPage: number;
  variant?: "row" | "inline" | undefined;
  showFileActions?: boolean | undefined;
  onPrint?: (() => void) | undefined;
  printDisabled?: boolean | undefined;
  extraControls?: ReactNode | undefined;
};

export const PdfViewerControls = ({
  workspaceId,
  fieldId,
  currentPage,
  variant = "row",
  showFileActions = true,
  onPrint,
  printDisabled = false,
  extraControls,
}: PdfViewerControlsProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const { data: fileMetadata } = useQuery({
    ...fileMetadataOptions({ workspaceId, fieldId }),
    enabled: fieldId.length > 0,
  });

  const totalPages = useWorkspaceStore((s) => s.pdfPageCount);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const setPdfScaleOffset = useWorkspaceStore((s) => s.setPdfScaleOffset);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const pageInputValue = editingPage ?? currentPage;
  const isDocx =
    fileMetadata?.originalMimeType === DOCX_MIME ||
    fileMetadata?.mimeType === DOCX_MIME;
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/document",
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

  const handleDownload = async () => {
    if (!fileMetadata || fieldId.length === 0 || isDownloading) {
      return;
    }

    setIsDownloading(true);
    try {
      const response = await api
        .files({ workspaceId })
        .url({ fieldId })
        .get({ query: { purpose: "download" } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      const fileResponse = await fetch(response.data.presignedUrl, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!fileResponse.ok) {
        throw new ClientOperationError({
          action: "downloadFullViewFile",
          message: "Failed to fetch file from storage",
        });
      }

      downloadFile(await fileResponse.blob(), fileMetadata.fileName);
    } catch (error: unknown) {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handlePrint = async () => {
    if (fieldId.length === 0 || isPrinting) {
      return;
    }

    if (onPrint) {
      onPrint();
      return;
    }

    setIsPrinting(true);
    try {
      const data = await fetchPrintPdf({ workspaceId, fieldId });
      printPdfBuffer(data);
    } catch (error: unknown) {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    } finally {
      setIsPrinting(false);
    }
  };

  const primaryControls = (
    <div className="flex items-center gap-1">
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

  const fileActions =
    showFileActions || extraControls !== undefined ? (
      <div className="flex items-center">
        {showFileActions && (
          <>
            <Tooltip
              content={t("common.download")}
              render={
                <Button
                  disabled={
                    !fileMetadata || isDownloading || fieldId.length === 0
                  }
                  onClick={() => {
                    void handleDownload();
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <DownloadIcon className="size-3.5" />
                </Button>
              }
            />
            <Tooltip
              content={t("common.print")}
              render={
                <Button
                  disabled={printDisabled || isPrinting || fieldId.length === 0}
                  onClick={() => {
                    void handlePrint();
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <PrinterIcon className="size-3.5" />
                </Button>
              }
            />
          </>
        )}
        {extraControls}
      </div>
    ) : null;

  if (variant === "inline") {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <Separator className="mx-1 h-4" orientation="vertical" />
        {primaryControls}
        {fileActions !== null && (
          <>
            <Separator className="mx-1 h-4" orientation="vertical" />
            {fileActions}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
      <div />
      {primaryControls}
      <div className="flex justify-self-end">{fileActions}</div>
    </div>
  );
};
