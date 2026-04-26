import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import {
  FoldHorizontalIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  UnfoldHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { DocxEditorRef } from "@stella/folio";
import { Button } from "@stella/ui/components/button";
import "@stella/folio/editor.css";
import "./peek-docx.css";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { PDF_MIME_TYPE } from "@/consts";
import { useAnalytics } from "@/lib/analytics/provider";
import { DOCX_MIME } from "@/lib/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { PageAnonymization } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-anonymization";
import { PageCitation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-citation";

const DocxEditor = lazy(async () => {
  const m = await import("@stella/folio");
  return { default: m.DocxEditor };
});

const DOCX_BASE_ZOOM = 0.5;
const DOCX_MIN_ZOOM = 0.25;
const DOCX_MAX_ZOOM = 2;
const PINCH_SENSITIVITY = 0.005;

const clampDocxZoom = (zoom: number) =>
  Math.max(DOCX_MIN_ZOOM, Math.min(DOCX_MAX_ZOOM, zoom));

type PeekPdfViewerProps = {
  workspaceId: string;
  viewId: string;
  fieldId: string;
  entityId: string;
  activePropertyId: string;
  filePurpose?: "display" | "native-display" | undefined;
  scaleOffset: number;
  mimeType?: string | undefined;
  /** Called when navigating from peek to fullscreen PDF (e.g. inspector close). */
  onPeekNavigate?: (() => void) | undefined;
};

export const PeekPdfViewer = ({
  workspaceId,
  viewId,
  fieldId,
  entityId,
  activePropertyId,
  filePurpose = "display",
  scaleOffset,
  mimeType,
  onPeekNavigate,
}: PeekPdfViewerProps) => {
  const isImageOrigin = mimeType?.startsWith("image/") ?? false;

  const { data: file } = useSuspenseQuery(
    fileOptions({ workspaceId, fieldId, purpose: filePurpose }),
  );

  const renderPageOverlay = useCallback(
    (pageId: string) => (
      <PeekPageOverlays
        activePropertyId={activePropertyId}
        entityId={entityId}
        fieldId={fieldId}
        onPeekNavigate={onPeekNavigate}
        pageId={pageId}
        viewId={viewId}
        workspaceId={workspaceId}
      />
    ),
    [activePropertyId, entityId, fieldId, onPeekNavigate, viewId, workspaceId],
  );

  if (file.mimeType === DOCX_MIME) {
    return (
      <Suspense fallback={<PeekSuspenseFallback />}>
        <PeekDocxViewer buffer={file.buffer} scaleOffset={scaleOffset} />
      </Suspense>
    );
  }

  return (
    <PDFViewport
      buffer={file.buffer}
      className="bg-muted relative space-y-2 px-2 pt-2"
      fileId={file.fileId}
      invertColors={isImageOrigin ? false : undefined}
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
  const analytics = useAnalytics();
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
      analytics.captureError(error);
    } finally {
      if (isMounted.current) {
        setIsPrinting(false);
      }
    }
  }, [analytics, pdfDocument]);

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

// ── DOCX peek viewer with zoom wiring ──────────────────

const PeekDocxViewer = ({
  buffer,
  scaleOffset,
}: {
  buffer: ArrayBuffer;
  scaleOffset: number;
}) => {
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialZoom = clampDocxZoom(DOCX_BASE_ZOOM + scaleOffset);

  // Sync scaleOffset from inspector +/- buttons to Folio zoom
  useEffect(() => {
    editorRef.current?.setZoom(initialZoom);
  }, [initialZoom]);

  // Pinch-to-zoom (Cmd/Ctrl+wheel on Mac trackpad)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }
      e.preventDefault();

      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      const currentZoom = editor.getZoom();
      const delta = -e.deltaY * PINCH_SENSITIVITY;
      const next = clampDocxZoom(currentZoom + delta);
      editor.setZoom(Math.round(next * 100) / 100);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, []);

  return (
    <div ref={containerRef} className="h-full overflow-auto">
      <DocxEditor
        ref={editorRef}
        className="folio-peek h-full"
        documentBuffer={buffer}
        initialZoom={initialZoom}
        loadingIndicator={null}
        readOnly
        showToolbar={false}
        showZoomControl={false}
      />
    </div>
  );
};

const PeekPageOverlays = ({
  workspaceId,
  viewId,
  fieldId,
  entityId,
  activePropertyId,
  onPeekNavigate,
  pageId,
}: {
  workspaceId: string;
  viewId: string;
  fieldId: string;
  entityId: string;
  activePropertyId: string;
  onPeekNavigate?: (() => void) | undefined;
  pageId: string;
}) => {
  const page = usePDFStore((s) => s.pages.get(pageId));
  const hasAnonymization = usePDFStore((s) => s.fileAnonymization !== null);

  if (!page) {
    return null;
  }

  return (
    <>
      <PageAnonymization
        onPeekNavigate={onPeekNavigate}
        pageId={pageId}
        pageIndex={page.proxy.pageNumber - 1}
        variant="peek"
        {...(hasAnonymization
          ? {
              peekNavigation: {
                activePropertyId,
                entityId,
                fieldId,
                viewId,
                workspaceId,
              },
            }
          : {})}
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
