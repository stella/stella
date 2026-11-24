import { useState } from "react";
import type { ReactNode } from "react";

import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EditPagesIcon,
  PrinterIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Separator } from "@stll/ui/separator";
import { ToolbarIconAction } from "@stll/ui/toolbar-icon-action";

import { DownloadSplitButton } from "@/components/inspector/download-rendition-menu";
import { downloadTabFile } from "@/components/inspector/file-download-service";
import type { DownloadRendition } from "@/components/inspector/file-download-service.logic";
import { PdfSignButton } from "@/components/inspector/pdf-sign-action";
import type { PdfSignTarget } from "@/components/inspector/pdf-sign-action";
import {
  PDF_PAGE_FIELD_ROW_CLASS,
  PDF_ZOOM_GROUP_CLASS,
  PdfPageCount,
} from "@/components/pdf/pdf-viewer.pending";
import {
  fetchPrintPdf,
  printPdfBuffer,
} from "@/components/pdf/peek/peek-pdf-print";
import { PeekPdfControls } from "@/components/pdf/peek/peek-pdf-viewer";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { hasPDFColorControl } from "@/lib/pdf/pdf-color-mode";
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

/** The open file as the page already holds it. */
type PdfViewerControlsFile = { fileName: string; mimeType: string };

type PdfViewerControlsProps = {
  workspaceId: string;
  fieldId: string;
  /**
   * The open file, from the entity the page loaded; `null` while the page
   * still resolves it. The controls take it from the page rather than a read
   * of their own, so they paint complete with the page and never shift the
   * centred cluster when a late read lands.
   */
  file: PdfViewerControlsFile | null;
  currentPage: number;
  downloadRenditions: readonly DownloadRendition[];
  variant?: "row" | "inline" | undefined;
  showFileActions?: boolean | undefined;
  onPrint?: (() => void) | undefined;
  printDisabled?: boolean | undefined;
  onEditPages?: (() => void) | undefined;
  /** The current PDF the viewer may sign; `null` offers no signing. */
  pdfSignTarget?: PdfSignTarget | null | undefined;
  extraControls?: ReactNode | undefined;
};

export const PdfViewerControls = ({
  workspaceId,
  fieldId,
  file,
  currentPage,
  downloadRenditions,
  variant = "row",
  showFileActions = true,
  onPrint,
  printDisabled = false,
  onEditPages,
  pdfSignTarget,
  extraControls,
}: PdfViewerControlsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const totalPages = useWorkspaceStore((s) => s.pdfPageCount);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const setPdfScaleOffset = useWorkspaceStore((s) => s.setPdfScaleOffset);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const pageInputValue = editingPage ?? currentPage;
  const isDocx = file?.mimeType === DOCX_MIME;
  const pdfColorMode = routeApi.useSearch({
    select: (search) => search.pdfColorMode ?? "system",
  });
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/document",
  });
  const canAdjustPDFColor = file !== null && hasPDFColorControl(file.mimeType);

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
      analytics.captureError(error, {
        fingerprintKey: "PdfViewerControls.handlePrint:failure",
        scope: {
          type: "handler",
          handlerId: "PdfViewerControls.handlePrint:failure",
        },
      });
      notifyUserError(error, t("errors.actionFailed"));
    } finally {
      setIsPrinting(false);
    }
  };

  const primaryControls = (
    <div className="flex items-center gap-1">
      <div className={PDF_ZOOM_GROUP_CLASS}>
        <PeekPdfControls
          atMax={scaleOffset >= PDF_MAX_SCALE_OFFSET}
          atMin={scaleOffset <= PDF_MIN_SCALE_OFFSET}
          onReset={() => navigateToScale(0)}
          onZoom={(direction) =>
            navigateToScale(
              getPDFScaleOffset(
                scaleOffset,
                direction === "in"
                  ? PDF_SCALE_OFFSET_STEP
                  : -PDF_SCALE_OFFSET_STEP,
              ),
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
            disabledReason={t("common.firstPageReached")}
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
            disabledReason={t("common.lastPageReached")}
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
          {/* The "/ total" sits on the field's centre line, so it never
              floats above the box. */}
          <div className={PDF_PAGE_FIELD_ROW_CLASS}>
            <Input
              aria-label={t("common.currentPage")}
              autoComplete="off"
              className="me-1 w-14 *:text-end"
              dir="ltr"
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
              size="sm"
              value={pageInputValue}
            />
            <span>/</span>
            <PdfPageCount
              formattedCount={
                totalPages > 0 ? format.number(totalPages) : undefined
              }
            />
          </div>
        </>
      )}
    </div>
  );

  const resolvePrintDisabledReason = () => {
    if (isPrinting) {
      return t("common.printing");
    }
    if (printDisabled) {
      return t("common.loading");
    }
    return t("workspaces.files.pdfSelectToPrint");
  };

  const fileActions =
    showFileActions || extraControls !== undefined ? (
      <div className="flex items-center">
        {showFileActions && (
          <>
            {onEditPages && !isDocx && (
              <ToolbarIconAction
                density="toolbar"
                disabled={totalPages === 0}
                icon={<EditPagesIcon className="size-3.5" />}
                label={t("workspaces.pdf.pageEditor.editPages")}
                onClick={onEditPages}
              />
            )}
            {pdfSignTarget !== null && pdfSignTarget !== undefined && (
              <PdfSignButton target={pdfSignTarget} />
            )}
            {file !== null && fieldId.length > 0 && (
              <DownloadSplitButton
                onDownload={(downloadVariant) =>
                  detached(
                    downloadTabFile({
                      fieldId,
                      fileName: file.fileName,
                      variant: downloadVariant,
                      workspaceId,
                      onError: (message, error) => {
                        notifyUserError(error, message);
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
              disabledReason={resolvePrintDisabledReason()}
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
