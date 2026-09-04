import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  FoldHorizontalIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  PrinterIcon,
  SunIcon,
  UnfoldHorizontalIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { resolveFindMatchRange } from "@stll/folio-core/prosemirror/findReplaceSelection";
import type { DocxEditorRef } from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";
import type { OverlayLayer } from "@stll/ui/overlay-layer";
import { Separator } from "@stll/ui/separator";
import "@stll/folio-react/editor.css";

import "./peek-docx.css";
import { composeRefs } from "@stll/ui/utils";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import {
  DOCX_PAGE_FIT_WIDTH,
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import { useDocxBlockScroll } from "@/components/docx/use-docx-block-scroll";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { PageAnonymization } from "@/components/pdf/page-anonymization";
import { PageCitation } from "@/components/pdf/page-citation";
import { resolvePendingPdfCitationPageId } from "@/components/pdf/peek/pdf-citation-navigation.logic";
import {
  fetchPrintPdf,
  printPdfBuffer,
} from "@/components/pdf/peek/peek-pdf-print";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { StellaMark } from "@/components/stella-mark";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { findDocumentSearchResult } from "@/lib/document-search";
import type { DocumentSearchResult } from "@/lib/document-search";
import { fileOptions } from "@/lib/files/queries";
import {
  PDF_COLOR_MODES,
  resolvePDFInvertColors,
  type PDFColorMode,
} from "@/lib/pdf/pdf-color-mode";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import type { SearchMatchSummary } from "@/lib/search-match-navigation";
import { MAX_SEARCH_PREVIEW_MATCHES } from "@/lib/search-match-navigation";
import { searchTextQueryKey } from "@/lib/search-text";
import type { SearchTextQuery } from "@/lib/search-text";

const DocxEditor = lazy(async () => {
  const m = await import("@/components/docx/app-docx-editor");
  return { default: m.DocxEditor };
});

const SEARCH_HIGHLIGHT_MAX_ANIMATION_FRAMES = 120;

type ScheduleSearchHighlightFrameOptions = {
  attempt: () => boolean;
  onFrame: (frame: number | null) => void;
  remainingFrames?: number | undefined;
};

type DocxSearchResultCache = {
  document: ReturnType<DocxEditorRef["getDocument"]>;
  result: DocumentSearchResult;
  searchTextKey: string;
};

const scheduleSearchHighlightFrame = ({
  attempt,
  onFrame,
  remainingFrames = SEARCH_HIGHLIGHT_MAX_ANIMATION_FRAMES,
}: ScheduleSearchHighlightFrameOptions): void => {
  if (attempt() || remainingFrames <= 1) {
    onFrame(null);
    return;
  }

  const frame = requestAnimationFrame(() => {
    scheduleSearchHighlightFrame({
      attempt,
      onFrame,
      remainingFrames: remainingFrames - 1,
    });
  });
  onFrame(frame);
};

type PeekPdfViewerProps = {
  workspaceId: string;
  viewId: string;
  fieldId: string;
  entityId: string;
  activePropertyId: string;
  filePurpose?: "display" | "native-display" | undefined;
  scaleOffset: number;
  mimeType?: string | undefined;
  interactionMode?: "preview-only" | "with-ai" | undefined;
  searchText?: SearchTextQuery | undefined;
  activeSearchMatchIndex?: number | undefined;
  onSearchMatchSummaryChange?:
    | ((summary: SearchMatchSummary) => void)
    | undefined;
  /** Called when navigating from peek to fullscreen PDF (e.g. inspector close). */
  onPeekNavigate?: (() => void) | undefined;
  docxPrintActionsRef?: RefObject<Map<string, () => void>> | undefined;
  onDocxScrollTopChange?: ((scrollTop: number) => void) | undefined;
  onWheelZoom?: ((deltaY: number) => void) | undefined;
  /**
   * DOCX auto-fit target. "text-area" fills the panel with body text and lets
   * the page margins overflow (inspector reading mode); "page" fits the whole
   * page inside the panel so narrow previews never scroll horizontally.
   */
  docxFitMode?: "text-area" | "page" | undefined;
  errorFallback?: ((props: { reset: () => void }) => ReactNode) | undefined;
  onError?: ((error: Error) => void) | undefined;
  colorMode?: PDFColorMode | undefined;
};

export const PeekPdfViewer = (props: PeekPdfViewerProps) => {
  const {
    errorFallback,
    fieldId,
    filePurpose = "display",
    onError,
    searchText,
    workspaceId,
  } = props;
  const searchTextKey =
    searchText === undefined ? undefined : searchTextQueryKey(searchText);

  return (
    <QuerySuspenseBoundary
      area="peek-viewer"
      errorFallback={errorFallback ?? defaultPeekViewerErrorFallback}
      suspenseFallback={<PeekSuspenseFallback />}
      onError={onError}
      resetKeys={[workspaceId, fieldId, filePurpose, searchTextKey]}
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
  interactionMode = "with-ai",
  searchText = "",
  activeSearchMatchIndex = 0,
  onSearchMatchSummaryChange,
  onPeekNavigate,
  docxPrintActionsRef,
  onDocxScrollTopChange,
  onWheelZoom,
  docxFitMode = "text-area",
  colorMode = "system",
}: PeekPdfViewerProps) => {
  const isImageOrigin = mimeType?.startsWith("image/") ?? false;
  const pendingPdfPageScroll = useInspectorCommandStore(
    (state) => state.pendingPdfPageScroll,
  );
  const clearPendingPdfPageScroll = useInspectorCommandStore(
    (state) => state.clearPendingPdfPageScroll,
  );

  const fileQuery = useQuery(
    fileOptions({ workspaceId, fieldId, purpose: filePurpose }),
  );
  const file = fileQuery.data;

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

  if (fileQuery.isError) {
    throw fileQuery.error;
  }
  if (!file) {
    return null;
  }

  if (file.mimeType === DOCX_MIME) {
    return (
      <Suspense fallback={<PeekSuspenseFallback />}>
        <PeekDocxViewer
          buffer={file.buffer}
          activeSearchMatchIndex={activeSearchMatchIndex}
          fieldId={fieldId}
          fitMode={docxFitMode}
          printActionsRef={docxPrintActionsRef}
          onScrollTopChange={onDocxScrollTopChange}
          onSearchMatchSummaryChange={onSearchMatchSummaryChange}
          scaleOffset={scaleOffset}
          searchText={
            interactionMode === "preview-only" ? searchText : undefined
          }
          workspaceId={workspaceId}
        />
      </Suspense>
    );
  }

  const viewport = (
    <>
      <PeekPdfCitationNavigation
        clearPendingPdfPageScroll={clearPendingPdfPageScroll}
        fieldId={fieldId}
        pendingPdfPageScroll={pendingPdfPageScroll}
      />
      <PDFViewport
        buffer={file.buffer}
        className="document-preview-surface h-full"
        contentClassName="relative space-y-2 px-2 pt-2"
        fileId={fieldId}
        invertColors={resolvePDFInvertColors({
          colorMode,
          isImageOrigin,
        })}
        scaleOffset={scaleOffset}
        activeSearchMatchIndex={activeSearchMatchIndex}
        onSearchMatchSummaryChange={onSearchMatchSummaryChange}
        onWheelZoom={onWheelZoom}
        searchText={searchText}
        renderPage={(props) => (
          <PDFPage {...props} renderOverlay={renderPageOverlay} />
        )}
      />
    </>
  );

  if (interactionMode === "preview-only") {
    return viewport;
  }

  return (
    <FileViewerWithAI
      activeFile={{ entityId, fileFieldId: fieldId, fileName: file.fileName }}
      workspaceId={workspaceId}
    >
      {viewport}
    </FileViewerWithAI>
  );
};

const PeekPdfCitationNavigation = ({
  clearPendingPdfPageScroll,
  fieldId,
  pendingPdfPageScroll,
}: {
  clearPendingPdfPageScroll: () => void;
  fieldId: string;
  pendingPdfPageScroll: { tabId: string; pageNumber: number } | null;
}) => {
  const citationPageId = usePDFStore((state) =>
    resolvePendingPdfCitationPageId({
      fieldId,
      pages: state.pages,
      request: pendingPdfPageScroll,
    }),
  );
  const setScrollTo = usePDFStore((state) => state.setScrollTo);

  // A chat citation may activate a file before its lazy PDF viewer exists.
  // This consumer renders only on the PDF branch, below PDFProvider; native
  // DOCX previews never read the PDF store.
  useExternalSyncEffect(() => {
    if (citationPageId === undefined) {
      return;
    }
    setScrollTo({ pageId: citationPageId });
    clearPendingPdfPageScroll();
  }, [citationPageId, clearPendingPdfPageScroll, setScrollTo]);

  return null;
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

const PDF_COLOR_MODE_ICONS = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
} as const satisfies Record<PDFColorMode, typeof SunIcon>;

type PeekPdfColorControl = {
  colorMode: PDFColorMode;
  onColorModeChange: (colorMode: PDFColorMode) => void;
};

type PeekPdfControlsProps = {
  canResetZoom: boolean;
  onZoomIn?: (() => void) | undefined;
  onZoomOut?: (() => void) | undefined;
  onResetZoom?: (() => void) | undefined;
  pdfColorControl?: PeekPdfColorControl | undefined;
  scaleOffset: number;
  tooltipLayer?: OverlayLayer | undefined;
};

const PDFColorModeControl = ({
  colorMode,
  onColorModeChange,
}: PeekPdfColorControl) => {
  const t = useTranslations();
  const PDFColorModeIcon = PDF_COLOR_MODE_ICONS[colorMode];

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("workspaces.pdf.adjustForDarkMode")}
        render={<Button size="icon-xs" variant="ghost" />}
        title={t("workspaces.pdf.adjustForDarkMode")}
      >
        <PDFColorModeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup className="w-auto" align="end">
        <MenuRadioGroup className="flex" value={colorMode}>
          {PDF_COLOR_MODES.map((mode) => {
            const ColorModeIcon = PDF_COLOR_MODE_ICONS[mode];
            return (
              <MenuRadioItem
                className="data-checked:bg-accent data-checked:text-accent-foreground"
                indicator="none"
                key={mode}
                onClick={() => onColorModeChange(mode)}
                value={mode}
              >
                <ColorModeIcon />
                {t(`appearance.${mode}`)}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};

export const PeekPdfControls = ({
  canResetZoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  pdfColorControl,
  scaleOffset,
  tooltipLayer,
}: PeekPdfControlsProps) => {
  const t = useTranslations();

  return (
    <>
      <Button
        disabled={!onZoomOut}
        onClick={onZoomOut}
        size="icon-xs"
        tooltip={t("workspaces.pdf.zoomOut")}
        tooltipLayer={tooltipLayer}
        variant="ghost"
      >
        <MinusIcon className="size-3" />
      </Button>
      <Button
        disabled={!onZoomIn}
        onClick={onZoomIn}
        size="icon-xs"
        tooltip={t("workspaces.pdf.zoomIn")}
        tooltipLayer={tooltipLayer}
        variant="ghost"
      >
        <PlusIcon className="size-3" />
      </Button>
      <Button
        disabled={!canResetZoom || !onResetZoom}
        onClick={onResetZoom}
        size="icon-xs"
        tooltip={t("workspaces.pdf.resetZoom")}
        tooltipLayer={tooltipLayer}
        variant="ghost"
      >
        {scaleOffset > 0 ? (
          <FoldHorizontalIcon className="size-3" />
        ) : (
          <UnfoldHorizontalIcon className="size-3" />
        )}
      </Button>
      {pdfColorControl && (
        <>
          <Separator className="mx-0.5 h-4" orientation="vertical" />
          <PDFColorModeControl {...pdfColorControl} />
        </>
      )}
    </>
  );
};

export const PeekPrintButton = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const pdfDocument = usePDFStore((s) => s.document);
  const [isPrinting, setIsPrinting] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  useMountEffect(() => () => {
    abortControllerRef.current?.abort();
  });

  const handlePrint = useCallback(async () => {
    if (!pdfDocument) {
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsPrinting(true);
    try {
      const data = await pdfDocument.document.getData();
      if (controller.signal.aborted) {
        return;
      }
      printPdfBuffer(data.slice().buffer);
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      analytics.captureError(error);
    } finally {
      if (!controller.signal.aborted) {
        setIsPrinting(false);
      }
    }
  }, [analytics, pdfDocument]);

  return (
    <Button
      disabled={!pdfDocument || isPrinting}
      onClick={() => {
        detached(handlePrint(), "peek-pdf-viewer.print");
      }}
      size="icon-xs"
      tooltip={t("common.print")}
      variant="ghost"
    >
      <PrinterIcon className="size-3.5" />
    </Button>
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

  useMountEffect(() => () => {
    abortControllerRef.current?.abort();
  });

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
      if (controller.signal.aborted) {
        return;
      }
      printPdfBuffer(data);
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      analytics.captureError(error);
    } finally {
      if (!controller.signal.aborted) {
        setIsPrinting(false);
      }
    }
  }, [analytics, fieldId, workspaceId]);

  return (
    <Button
      disabled={disabled || isPrinting || fieldId.length === 0}
      onClick={() => {
        detached(handlePrint(), "peek-pdf-viewer.print");
      }}
      size="icon-xs"
      tooltip={t("common.print")}
      variant="ghost"
    >
      <PrinterIcon className="size-3.5" />
    </Button>
  );
};

// ── DOCX peek viewer with zoom wiring ──────────────────

const PeekDocxViewer = ({
  activeSearchMatchIndex,
  buffer,
  fieldId,
  fitMode,
  onScrollTopChange,
  onSearchMatchSummaryChange,
  printActionsRef,
  scaleOffset,
  searchText,
  workspaceId,
}: {
  activeSearchMatchIndex: number;
  buffer: ArrayBuffer;
  fieldId: string;
  fitMode: "text-area" | "page";
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  onSearchMatchSummaryChange?:
    | ((summary: SearchMatchSummary) => void)
    | undefined;
  printActionsRef?: RefObject<Map<string, () => void>> | undefined;
  scaleOffset: number;
  searchText: SearchTextQuery | undefined;
  workspaceId: string;
}) => {
  const analytics = useAnalytics();
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchHighlightFrameRef = useRef<number | null>(null);
  const searchResultCacheRef = useRef<DocxSearchResultCache | null>(null);
  const { containerRef: fitZoomRef, fitZoom: targetZoom } = useDocxFitZoom({
    scaleOffset,
    ...(fitMode === "page" && {
      fitWidth: DOCX_PAGE_FIT_WIDTH,
      maxAutoZoom: 1,
    }),
  });
  // Stable ref callback so React doesn't detach/re-attach the fit-zoom
  // ResizeObserver every render.
  const composedContainerRef = useMemo(
    () => composeRefs(containerRef, fitZoomRef),
    [fitZoomRef],
  );
  useDocxBlockScroll({ editorRef, fieldId });
  const searchTextKey =
    searchText === undefined ? undefined : searchTextQueryKey(searchText);

  const highlightSearchResult = useCallback(() => {
    if (searchText === undefined) {
      return true;
    }

    const editor = editorRef.current;
    if (!editor) {
      return false;
    }

    editor.ensureEditorView({ focus: false });
    const pagedEditor = editor.getEditorRef();
    if (!pagedEditor) {
      return false;
    }
    const view = pagedEditor.getView();
    if (!view) {
      return false;
    }

    const document = editor.getDocument();
    const cachedSearchResult = searchResultCacheRef.current;
    const searchResult =
      cachedSearchResult?.document === document &&
      cachedSearchResult.searchTextKey === searchTextKey
        ? cachedSearchResult.result
        : findDocumentSearchResult({
            document,
            maxMatches: MAX_SEARCH_PREVIEW_MATCHES,
            searchText,
          });
    searchResultCacheRef.current = {
      document,
      result: searchResult,
      searchTextKey: searchTextKey ?? "",
    };
    onSearchMatchSummaryChange?.({
      count: searchResult.matches.length,
      truncated: searchResult.truncated,
    });
    const match = searchResult.matches.at(activeSearchMatchIndex);
    if (!match) {
      pagedEditor.setPassageHighlight(null);
      return true;
    }

    const range = resolveFindMatchRange(view.state.doc, match);
    if (!range) {
      pagedEditor.setPassageHighlight(null);
      return true;
    }

    pagedEditor.setPassageHighlight(range);
    pagedEditor.scrollToPosition(range.from);
    return true;
  }, [
    activeSearchMatchIndex,
    onSearchMatchSummaryChange,
    searchText,
    searchTextKey,
  ]);

  const scheduleSearchHighlight = useCallback(() => {
    if (searchHighlightFrameRef.current !== null) {
      cancelAnimationFrame(searchHighlightFrameRef.current);
    }

    scheduleSearchHighlightFrame({
      attempt: highlightSearchResult,
      onFrame: (frame) => {
        searchHighlightFrameRef.current = frame;
      },
    });
  }, [highlightSearchResult]);

  useMountEffect(() => () => {
    if (searchHighlightFrameRef.current !== null) {
      cancelAnimationFrame(searchHighlightFrameRef.current);
    }
  });

  useExternalSyncEffect(() => {
    scheduleSearchHighlight();
  }, [scheduleSearchHighlight]);

  const handleDocumentReady = useCallback(() => {
    searchResultCacheRef.current = null;
    scheduleSearchHighlight();
  }, [scheduleSearchHighlight]);

  const handleEditorViewReady = useCallback(() => {
    searchResultCacheRef.current = null;
    scheduleSearchHighlight();
  }, [scheduleSearchHighlight]);

  // Sync scaleOffset from inspector +/- buttons to Folio zoom
  useLayoutEffect(() => {
    editorRef.current?.setZoom(targetZoom);
  }, [targetZoom]);
  useDocxWheelZoom(containerRef, editorRef);

  useExternalSyncEffect(() => {
    if (!printActionsRef) {
      return undefined;
    }

    const printActions = printActionsRef.current;
    const print = () => {
      detached(
        fetchPrintPdf({ workspaceId, fieldId })
          .then(printPdfBuffer)
          .catch((error: unknown) => {
            analytics.captureError(error);
          }),
        "peek-pdf-viewer.fetch-print-pdf",
      );
    };
    printActions.set(fieldId, print);

    return () => {
      if (printActions.get(fieldId) === print) {
        printActions.delete(fieldId);
      }
    };
  }, [analytics, fieldId, printActionsRef, workspaceId]);

  return (
    <div ref={composedContainerRef} className="h-full overflow-auto">
      <DocxEditor
        ref={editorRef}
        autoOpenReviewSidebar={false}
        className="folio-docx-preview folio-peek h-full"
        documentBuffer={buffer}
        initialZoom={targetZoom}
        loadingIndicator={null}
        onCompatibilityChange={handleDocumentReady}
        onEditorViewReady={handleEditorViewReady}
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
