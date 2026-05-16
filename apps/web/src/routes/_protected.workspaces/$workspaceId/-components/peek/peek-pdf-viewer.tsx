import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  FoldHorizontalIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  UnfoldHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { DocxEditorRef } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import "@stll/folio/editor.css";

import "./peek-docx.css";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { StellaMark } from "@/components/stella-mark";
import Tooltip from "@/components/tooltip";
import { PDF_MIME_TYPE } from "@/consts";
import { env } from "@/env";
import { useAnalytics } from "@/lib/analytics/provider";
import { chatThreadIdFromFileFieldId } from "@/lib/chat-thread-ref";
import { DOCX_MIME } from "@/lib/consts";
import { APIError } from "@/lib/errors";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import {
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-preview-zoom";
import { useDocxBlockScroll } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/use-docx-block-scroll";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { PageAnonymization } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-anonymization";
import { PageCitation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-citation";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

const PRINT_IFRAME_CLEANUP_MS = 5 * 60 * 1000;

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
  docxPrintActionsRef?: RefObject<Map<string, () => void>> | undefined;
  onDocxScrollTopChange?: ((scrollTop: number) => void) | undefined;
  errorFallback?: ((props: { reset: () => void }) => ReactNode) | undefined;
  onError?: ((error: Error) => void) | undefined;
};

export const PeekPdfViewer = (props: PeekPdfViewerProps) => {
  const {
    errorFallback,
    fieldId,
    filePurpose = "display",
    onError,
    workspaceId,
  } = props;

  return (
    <QuerySuspenseBoundary
      area="peek-viewer"
      errorFallback={errorFallback ?? defaultPeekViewerErrorFallback}
      suspenseFallback={<PeekSuspenseFallback />}
      onError={onError}
      resetKeys={[workspaceId, fieldId, filePurpose]}
    >
      <PeekPdfViewerContent {...props} filePurpose={filePurpose} />
    </QuerySuspenseBoundary>
  );
};

const PeekPdfViewerContent = ({
  workspaceId,
  viewId,
  fieldId,
  entityId,
  activePropertyId,
  filePurpose = "display",
  scaleOffset,
  mimeType,
  onPeekNavigate,
  docxPrintActionsRef,
  onDocxScrollTopChange,
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
        <PeekDocxViewer
          buffer={file.buffer}
          fieldId={fieldId}
          printActionsRef={docxPrintActionsRef}
          onScrollTopChange={onDocxScrollTopChange}
          scaleOffset={scaleOffset}
          workspaceId={workspaceId}
        />
      </Suspense>
    );
  }

  return (
    <FileViewerWithAI
      activeFile={{ entityId, fileFieldId: fieldId, fileName: file.fileName }}
      chatThreadId={chatThreadIdFromFileFieldId(fieldId)}
      workspaceId={workspaceId}
    >
      <PDFViewport
        buffer={file.buffer}
        className="document-preview-surface h-full"
        contentClassName="relative space-y-2 px-2 pt-2"
        fileId={fieldId}
        invertColors={isImageOrigin ? false : undefined}
        scaleOffset={scaleOffset}
        renderPage={(props) => (
          <PDFPage {...props} renderOverlay={renderPageOverlay} />
        )}
      />
    </FileViewerWithAI>
  );
};

const defaultPeekViewerErrorFallback = ({ reset }: { reset: () => void }) => (
  <PeekViewerErrorFallback onRetry={reset} />
);

export const PeekSuspenseFallback = () => (
  <div className="flex h-full w-full items-center justify-center">
    <StellaMark className="text-muted-foreground size-8 animate-pulse" />
  </div>
);

const PeekViewerErrorFallback = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangleIcon className="text-foreground-disabled size-8" />
      <p className="text-muted-foreground text-sm">
        {t("common.somethingWentWrong")}
      </p>
      <Button onClick={onRetry} size="sm" variant="outline">
        {t("common.tryAgain")}
      </Button>
    </div>
  );
};

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

export const printPdfBuffer = (buffer: ArrayBuffer) => {
  const blob = new Blob([buffer], {
    type: PDF_MIME_TYPE,
  });
  const url = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = url;
  document.body.append(frame);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    frame.remove();
    URL.revokeObjectURL(url);
  };
  setTimeout(cleanup, PRINT_IFRAME_CLEANUP_MS);

  frame.addEventListener("load", () => {
    if (!frame.contentWindow) {
      cleanup();
      return;
    }
    frame.contentWindow.addEventListener("afterprint", cleanup, { once: true });
    frame.contentWindow.print();
  });
};

export const fetchPrintPdf = async ({
  workspaceId,
  fieldId,
  signal,
}: {
  workspaceId: string;
  fieldId: string;
  signal?: AbortSignal | undefined;
}) => {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(
    `${env.VITE_API_URL}/v1/files/${workspaceId}/print-pdf/${fieldId}`,
    { credentials: "include", signal: combinedSignal },
  );

  if (!response.ok) {
    throw new APIError({
      status: response.status,
      message: "Failed to prepare printable PDF",
    });
  }

  return await response.arrayBuffer();
};

export const PeekPrintButton = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const pdfDocument = usePDFStore((s) => s.document);
  const [isPrinting, setIsPrinting] = useState(false);

  const handlePrint = useCallback(async () => {
    if (!pdfDocument) {
      return;
    }

    setIsPrinting(true);
    try {
      const data = await pdfDocument.document.getData();
      printPdfBuffer(data.slice().buffer);
    } catch (error: unknown) {
      analytics.captureError(error);
    } finally {
      setIsPrinting(false);
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

export const PreparedPdfPrintButton = ({
  disabled = false,
  fieldId,
  workspaceId,
}: {
  disabled?: boolean | undefined;
  fieldId: string;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const [isPrinting, setIsPrinting] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  const handlePrint = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsPrinting(true);
    try {
      const data = await fetchPrintPdf({
        workspaceId,
        fieldId,
        signal: controller.signal,
      });
      printPdfBuffer(data);
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      analytics.captureError(error);
    } finally {
      setIsPrinting(false);
    }
  }, [analytics, fieldId, workspaceId]);

  return (
    <Tooltip
      content={t("common.print")}
      render={
        <Button
          disabled={disabled || isPrinting || fieldId.length === 0}
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
  fieldId,
  onScrollTopChange,
  printActionsRef,
  scaleOffset,
  workspaceId,
}: {
  buffer: ArrayBuffer;
  fieldId: string;
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  printActionsRef?: RefObject<Map<string, () => void>> | undefined;
  scaleOffset: number;
  workspaceId: string;
}) => {
  const analytics = useAnalytics();
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const targetZoom = useDocxFitZoom(containerRef, scaleOffset);
  useDocxBlockScroll({ editorRef, fieldId });

  // Sync scaleOffset from inspector +/- buttons to Folio zoom
  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);

  useEffect(() => {
    if (!printActionsRef) {
      return undefined;
    }

    const printActions = printActionsRef.current;
    const print = () => {
      void fetchPrintPdf({ workspaceId, fieldId })
        .then(printPdfBuffer)
        .catch((error: unknown) => {
          analytics.captureError(error);
        });
    };
    printActions.set(fieldId, print);

    return () => {
      if (printActions.get(fieldId) === print) {
        printActions.delete(fieldId);
      }
    };
  }, [analytics, fieldId, printActionsRef, workspaceId]);

  return (
    <div ref={containerRef} className="h-full overflow-auto">
      <DocxEditor
        ref={editorRef}
        autoOpenReviewSidebar={false}
        className="folio-docx-preview folio-peek h-full"
        documentBuffer={buffer}
        initialZoom={targetZoom}
        loadingIndicator={null}
        readOnly
        showToolbar={false}
        showZoomControl={false}
        {...(onScrollTopChange !== undefined ? { onScrollTopChange } : {})}
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
