import { useCallback, useEffect, useRef, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import {
  FoldHorizontalIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  UnfoldHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";

import { StellaMark } from "@/components/stella-mark";
import { useTheme } from "@/components/theme-provider";
import Tooltip from "@/components/tooltip";
import { PDF_MIME_TYPE } from "@/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { PageAnonymisation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-anonymisation";
import { PageCitation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-citation";

type PeekPdfViewerProps = {
  workspaceId: string;
  fieldId: string;
  scaleOffset: number;
};

export const PeekPdfViewer = ({
  workspaceId,
  fieldId,
  scaleOffset,
}: PeekPdfViewerProps) => {
  const { resolvedTheme } = useTheme();

  const { data: file } = useSuspenseQuery(
    fileOptions({ workspaceId, fieldId }),
  );

  const renderPageOverlay = useCallback(
    (pageId: string) => <PeekPageOverlays fieldId={fieldId} pageId={pageId} />,
    [fieldId],
  );

  return (
    <PDFViewport
      buffer={file.buffer}
      className="bg-muted relative space-y-2 px-2 pt-2"
      fileId={file.fileId}
      invertColors={resolvedTheme === "dark"}
      scaleOffset={scaleOffset}
      renderPage={(props) => (
        <PDFPage {...props} renderOverlay={renderPageOverlay} />
      )}
    />
  );
};

export const PeekSuspenseFallback = () => (
  <div className="flex h-full w-full items-center justify-center">
    <StellaMark className="text-muted-foreground size-8 animate-pulse" />
  </div>
);

export const PeekPdfControls = ({
  canResetZoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  scaleOffset,
}: {
  canResetZoom: boolean;
  onZoomIn?: (() => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onResetZoom?: (() => void) | undefined;
  scaleOffset: number;
}) => {
  const t = useTranslations();

  return (
    <>
      <Tooltip
        content={t("workspaces.pdf.zoomOut")}
        render={
          <Button
            disabled={!onZoomOut}
            onClick={onZoomOut}
            size="icon-xs"
            variant="ghost"
          >
            <MinusIcon className="size-3" />
          </Button>
        }
      />
      <Tooltip
        content={t("workspaces.pdf.zoomIn")}
        render={
          <Button
            disabled={!onZoomIn}
            onClick={onZoomIn}
            size="icon-xs"
            variant="ghost"
          >
            <PlusIcon className="size-3" />
          </Button>
        }
      />
      <Tooltip
        content={t("workspaces.pdf.resetZoom")}
        render={
          <Button
            disabled={!canResetZoom || !onResetZoom}
            onClick={onResetZoom}
            size="icon-xs"
            variant="ghost"
          >
            {scaleOffset > 0 ? (
              <FoldHorizontalIcon className="size-3" />
            ) : (
              <UnfoldHorizontalIcon className="size-3" />
            )}
          </Button>
        }
      />
    </>
  );
};

export const PeekPrintButton = () => {
  const t = useTranslations();
  const pdfDocument = usePDFStore((s) => s.document);
  const [isPrinting, setIsPrinting] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const handlePrint = useCallback(async () => {
    if (!pdfDocument) {
      return;
    }

    setIsPrinting(true);
    try {
      const data = await pdfDocument.document.getData();

      if (!isMounted.current) {
        return;
      }

      const blob = new Blob([data.slice().buffer], {
        type: PDF_MIME_TYPE,
      });
      const url = URL.createObjectURL(blob);
      const frame = document.createElement("iframe");
      frame.style.display = "none";
      frame.src = url;
      document.body.append(frame);
      frame.addEventListener("load", () => {
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          frame.remove();
          URL.revokeObjectURL(url);
        };
        if (!frame.contentWindow) {
          cleanup();
          return;
        }
        frame.contentWindow.addEventListener("afterprint", cleanup);
        // Fallback: clean up after 5 minutes if afterprint
        // never fires (defensive; spec guarantees the event).
        setTimeout(cleanup, 5 * 60 * 1000);
        frame.contentWindow.print();
      });
    } catch (error: unknown) {
      // oxlint-disable-next-line no-console
      console.error("Print failed:", error);
    } finally {
      if (isMounted.current) {
        setIsPrinting(false);
      }
    }
  }, [pdfDocument]);

  return (
    <Tooltip
      content={t("common.print")}
      render={
        <Button
          disabled={!pdfDocument || isPrinting}
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
  );
};

const PeekPageOverlays = ({
  fieldId,
  pageId,
}: {
  fieldId: string;
  pageId: string;
}) => {
  const page = usePDFStore((s) => s.pages.get(pageId));

  if (!page) {
    return null;
  }

  return (
    <>
      <PageAnonymisation
        fileId={fieldId}
        originalHeight={page.originalHeight}
        originalWidth={page.originalWidth}
        pageIndex={page.proxy.pageNumber - 1}
        scale={page.viewport.scale}
      />
      <PageCitation
        originalHeight={page.originalHeight}
        originalWidth={page.originalWidth}
        pageId={pageId}
        pageNumber={page.proxy.pageNumber}
        scale={page.viewport.scale}
      />
    </>
  );
};
