import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  FilePenLineIcon,
  PrinterIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Separator } from "@stll/ui/separator";
import { stellaToast } from "@stll/ui/toast";

import { DownloadSplitButton } from "@/components/inspector/download-rendition-menu";
import { downloadTabFile } from "@/components/inspector/file-download-service";
import type { DownloadRendition } from "@/components/inspector/file-download-service.logic";
import {
  fetchPrintPdf,
  printPdfBuffer,
} from "@/components/pdf/peek/peek-pdf-print";
import { PeekPdfControls } from "@/components/pdf/peek/peek-pdf-viewer";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { fileMetadataOptions } from "@/lib/files/file-metadata-query";
import type { PDFColorMode } from "@/lib/pdf/pdf-color-mode";
import {
  getPDFScaleOffset,
  PDF_MAX_SCALE_OFFSET,
  PDF_MIN_SCALE_OFFSET,
  PDF_SCALE_OFFSET_STEP,
} from "@/lib/pdf/pdf-zoom.logic";
import { useWorkspaceStore } from "@/lib/workspaces/store";

const routeApi = getRouteApi(
  "/_protected/workspaces/$workspaceId/$viewId/document",
);

type PdfViewerControlsProps = {
  workspaceId: string;
  fieldId: string;
  currentPage: number;
  downloadRenditions: readonly DownloadRendition[];
  variant?: "row" | "inline" | undefined;
  showFileActions?: boolean | undefined;
  onPrint?: (() => void) | undefined;
  printDisabled?: boolean | undefined;
  onEditPages?: (() => void) | undefined;
  extraControls?: ReactNode | undefined;
};

export const PdfViewerControls = ({
  workspaceId,
  fieldId,
  currentPage,
  downloadRenditions,
  variant = "row",
  showFileActions = true,
  onPrint,
  printDisabled = false,
  onEditPages,
  extraControls,
}: PdfViewerControlsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const { data: fileMetadata } = useQuery({
    ...fileMetadataOptions({ workspaceId, fieldId }),
    enabled: fieldId.length > 0,
  });

  const totalPages = useWorkspaceStore((s) => s.pdfPageCount);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const setPdfScaleOffset = useWorkspaceStore((s) => s.setPdfScaleOffset);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const pageInputValue = editingPage ?? currentPage;
  const isDocx =
    fileMetadata?.originalMimeType === DOCX_MIME ||
    fileMetadata?.mimeType === DOCX_MIME;
  const pdfColorMode = routeApi.useSearch({
    select: (search) => search.pdfColorMode ?? "system",
  });
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/document",
  });
  const canAdjustPDFColor =
    !isDocx &&
    fileMetadata !== undefined &&
    !fileMetadata.originalMimeType.startsWith("image/");

  const navigateToScale = (offset: number) => {
    setPdfScaleOffset(Math.round(offset * 10) / 10);
  };

  const navigateToPage = (pageNumber: number) => {
    detached(
      navigate({
        replace: true,
        search: (prev) =>
          produce(prev, (s) => {
            s.pdfPage = pageNumber;
          }),
      }),
      "pdf-viewer-controls.navigate",
    );
  };

  const setPDFColorMode = (colorMode: PDFColorMode) => {
    detached(
      navigate({
        replace: true,
        search: (previous) =>
          produce(previous, (search) => {
            search.pdfColorMode =
              colorMode === "system" ? undefined : colorMode;
          }),
      }),
      "pdf-viewer-controls.navigate",
    );
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
            scaleOffset >= PDF_MAX_SCALE_OFFSET
              ? undefined
              : () =>
                  navigateToScale(
                    getPDFScaleOffset(scaleOffset, PDF_SCALE_OFFSET_STEP),
                  )
          }
          onZoomOut={
            scaleOffset <= PDF_MIN_SCALE_OFFSET
              ? undefined
              : () =>
                  navigateToScale(
                    getPDFScaleOffset(scaleOffset, -PDF_SCALE_OFFSET_STEP),
                  )
          }
          pdfColorControl={
            canAdjustPDFColor
              ? {
                  colorMode: pdfColorMode,
                  onColorModeChange: setPDFColorMode,
                }
              : undefined
          }
          scaleOffset={scaleOffset}
        />
      </div>
      {!isDocx && (
        <>
          <Separator className="mx-1 h-4" orientation="vertical" />
          <Button
            disabled={currentPage <= 1}
            onClick={() => {
              setEditingPage(null);
              navigateToPage(currentPage - 1);
            }}
            size="icon-xs"
            tooltip={t("workspaces.pdf.previousPage")}
            variant="ghost"
          >
            <ChevronUpIcon className="size-3.5" />
          </Button>
          <Button
            disabled={currentPage >= totalPages}
            onClick={() => {
              setEditingPage(null);
              navigateToPage(currentPage + 1);
            }}
            size="icon-xs"
            tooltip={t("workspaces.pdf.nextPage")}
            variant="ghost"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
          <div className="ms-1.5 me-2 flex gap-x-1.5 text-sm">
            <input
              aria-label={t("common.currentPage")}
              autoComplete="off"
              dir="ltr"
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
            <span>{format.number(totalPages)}</span>
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
            {onEditPages && !isDocx && (
              <Button
                disabled={totalPages === 0}
                onClick={onEditPages}
                size="sm"
                variant="ghost"
              >
                <FilePenLineIcon />
                {t("workspaces.pdf.pageEditor.editPages")}
              </Button>
            )}
            {fileMetadata !== undefined && fieldId.length > 0 && (
              <DownloadSplitButton
                onDownload={(downloadVariant) =>
                  detached(
                    downloadTabFile({
                      fieldId,
                      fileName: fileMetadata.fileName,
                      variant: downloadVariant,
                      workspaceId,
                      onError: (message) => {
                        stellaToast.add({ title: message, type: "error" });
                      },
                    }),
                    "pdf-viewer-controls.download",
                  )
                }
                renditions={downloadRenditions}
              />
            )}
            <Button
              disabled={printDisabled || isPrinting || fieldId.length === 0}
              onClick={() => {
                detached(handlePrint(), "pdf-viewer-controls.print");
              }}
              size="icon-xs"
              tooltip={t("common.print")}
              variant="ghost"
            >
              <PrinterIcon className="size-3.5" />
            </Button>
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
