import { lazy, Suspense, useCallback, useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import { useQuery } from "@tanstack/react-query";
import type { Plugin } from "@tiptap/pm/state";
import { useTranslations } from "use-intl";

import { resolveFindMatchRange } from "@stll/folio-core/prosemirror/findReplaceSelection";
import type { DocxEditorRef } from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import { AlertTriangleIcon } from "@stll/ui/icons";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";
import { Separator } from "@stll/ui/separator";
import "@stll/folio-react/editor.css";

import "./peek-docx.css";
import { useExternalSyncEffect, useMountEffect } from "@stll/ui/effects";
import { useComposedRefs } from "@stll/ui/effects-refs";
import { cn } from "@stll/ui/utils";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import {
  DOCX_PAGE_FIT_WIDTH,
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import { useDocxBlockScroll } from "@/components/docx/use-docx-block-scroll";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { FilePreviewUnavailable } from "@/components/inspector/inspector-pdf-error-fallback";
import {
  PdfSignPlacementBar,
  PdfSignPlacementLayer,
} from "@/components/inspector/pdf-sign-placement-viewer";
import { VIEWER_OVERLAY_BAR_TOP_CLEARANCE } from "@/components/inspector/viewer-overlay-bar";
import { ZoomControls } from "@/components/inspector/zoom-controls";
import type { ZoomDirection } from "@/components/inspector/zoom-controls";
import { DocumentMarkPageLayer } from "@/components/pdf/annotations/document-marks-layer";
import { PageAnonymization } from "@/components/pdf/page-anonymization";
import { PageCitation } from "@/components/pdf/page-citation";
import { PdfSelectionActions } from "@/components/pdf/pdf-selection-actions";
import { PDF_SELECTION_CHAT } from "@/components/pdf/pdf-selection-toolbar";
import {
  PDF_COLOR_MODE_ICONS,
  PdfColorModeIcon,
} from "@/components/pdf/pdf-viewer.pending";
import { resolvePendingPdfCitationPageId } from "@/components/pdf/peek/pdf-citation-navigation.logic";
import {
  fetchPrintPdf,
  printPdfBuffer,
} from "@/components/pdf/peek/peek-pdf-print";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import { DefaultPendingComponent } from "@/components/route-components";
import { useAnalytics } from "@/lib/analytics/provider";
import { DOCX_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { findDocumentSearchResult } from "@/lib/document-search";
import type { DocumentSearchResult } from "@/lib/document-search";
import { isPreviewUnavailableError } from "@/lib/errors/api";
import { fileOptions } from "@/lib/files/queries";
import {
  PDF_COLOR_MODES,
  type PDFColorMode,
  resolvePDFInvertColors,
} from "@/lib/pdf/pdf-color-mode";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import type { PDFPageSource } from "@/lib/pdf/pdf-page-source";
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
  /**
   * Whether the viewer's controls float over the top inline-end corner of the
   * pages (`ViewerOverlayBar`). The first page then starts below the bar, so
   * at the top of the scroll the bar covers none of it.
   */
  underOverlayBar: boolean;
  searchText?: SearchTextQuery | undefined;
  activeSearchMatchIndex?: number | undefined;
  onSearchMatchSummaryChange?:
    ((summary: SearchMatchSummary) => void) | undefined;
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
  /**
   * Host ProseMirror plugins for a DOCX, handed to Folio as they are. Folio
   * keeps them across document replacement, so the array must keep its
   * identity for as long as the viewer is mounted.
   */
  docxPlugins?: readonly Plugin[] | undefined;
  /**
   * Extra marks over each rendered PDF page, after the viewer's own
   * overlays, positioned against the page box like any `PDFPage` overlay.
   */
  pdfPageOverlay?: ((pageId: string) => ReactNode) | undefined;
  /** Which pages a PDF shows: its own, or the PDFs a portfolio attaches. */
  pdfPageSource: PDFPageSource;
  errorFallback?: ((props: { reset: () => void }) => ReactNode) | undefined;
  onError?: ((error: Error) => void) | undefined;
  /** Offered when the file has no preview; without it the state is text only. */
  onDownload?: (() => void) | undefined;
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
  underOverlayBar,
  activeSearchMatchIndex = 0,
  onSearchMatchSummaryChange,
  onPeekNavigate,
  docxPrintActionsRef,
  onDocxScrollTopChange,
  onWheelZoom,
  docxFitMode = "text-area",
  docxPlugins,
  pdfPageOverlay,
  pdfPageSource,
  onDownload,
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

  const renderPageOverlay = (pageId: string) => (
    <>
      <PeekPageOverlays
        activePropertyId={activePropertyId}
        entityId={entityId}
        fieldId={fieldId}
        onPeekNavigate={onPeekNavigate}
        pageId={pageId}
        viewId={viewId}
        workspaceId={workspaceId}
      />
      {pdfPageOverlay?.(pageId)}
      {interactionMode === "preview-only" ? null : (
        <PdfSignPlacementLayer pageId={pageId} />
      )}
    </>
  );

  if (fileQuery.isError) {
    if (isPreviewUnavailableError(fileQuery.error)) {
      return <FilePreviewUnavailable onDownload={onDownload} />;
    }
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
          fileName={file.fileName}
          activeSearchMatchIndex={activeSearchMatchIndex}
          fieldId={fieldId}
          fitMode={docxFitMode}
          plugins={docxPlugins}
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
      <PeekPdfViewport
        activeSearchMatchIndex={activeSearchMatchIndex}
        buffer={file.buffer}
        colorMode={colorMode}
        fileId={fieldId}
        isImageOrigin={isImageOrigin}
        onSearchMatchSummaryChange={onSearchMatchSummaryChange}
        onWheelZoom={onWheelZoom}
        pageSource={pdfPageSource}
        renderPageOverlay={renderPageOverlay}
        scaleOffset={scaleOffset}
        searchText={searchText}
        underOverlayBar={underOverlayBar}
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
      <PdfSignPlacementBar fieldId={fieldId} key={fieldId} />
      <PdfSelectionActions
        chat={PDF_SELECTION_CHAT.fileChat}
        entityId={entityId}
        file={file}
        fileFieldId={fieldId}
        fileName={file.fileName}
        workspaceId={workspaceId}
      >
        {viewport}
      </PdfSelectionActions>
    </FileViewerWithAI>
  );
};

type PeekPdfViewportProps = {
  buffer: ArrayBuffer;
  /** Names the parsed document; distinct per set of bytes on screen. */
  fileId: string;
  pageSource: PDFPageSource;
  /** The zoom over the fit-to-width scale, as the zoom controls set it. */
  scaleOffset: number;
  colorMode: PDFColorMode;
  /**
   * Whether the viewer's controls float over the top inline-end corner of the
   * pages (`ViewerOverlayBar`). The first page then starts below the bar, so
   * at the top of the scroll the bar covers none of it.
   */
  underOverlayBar: boolean;
  isImageOrigin?: boolean | undefined;
  onWheelZoom?: ((deltaY: number) => void) | undefined;
  searchText?: SearchTextQuery | undefined;
  activeSearchMatchIndex?: number | undefined;
  onSearchMatchSummaryChange?:
    ((summary: SearchMatchSummary) => void) | undefined;
  renderPageOverlay?: ((pageId: string) => ReactNode) | undefined;
};

/**
 * The inspector's PDF pages, whatever file the bytes come from: the file's
 * own PDF, or one a signed container holds. Inside a measured PDF provider
 * the pages fit the panel's width, follow the zoom controls and zoom with
 * ctrl or cmd and the wheel, the same in every preview that draws a PDF.
 */
export const PeekPdfViewport = ({
  buffer,
  colorMode,
  fileId,
  isImageOrigin = false,
  pageSource,
  renderPageOverlay,
  underOverlayBar,
  ...props
}: PeekPdfViewportProps) => (
  <PDFViewport
    {...props}
    buffer={buffer}
    className="document-preview-surface h-full"
    contentClassName={cn(
      "relative space-y-2",
      underOverlayBar ? VIEWER_OVERLAY_BAR_TOP_CLEARANCE : "pt-2",
    )}
    fileId={fileId}
    invertColors={resolvePDFInvertColors({ colorMode, isImageOrigin })}
    pageSource={pageSource}
    renderPage={(pageProps) => (
      <PDFPage {...pageProps} renderOverlay={renderPageOverlay} />
    )}
  />
);

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

export const PeekSuspenseFallback = DefaultPendingComponent;

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

type PeekPdfColorControl = {
  colorMode: PDFColorMode;
  onColorModeChange: (colorMode: PDFColorMode) => void;
};

type PeekPdfControlsProps = {
  atMax?: boolean | undefined;
  atMin?: boolean | undefined;
  onReset: () => void;
  onZoom: (direction: ZoomDirection) => void;
  pdfColorControl?: PeekPdfColorControl | undefined;
  scaleOffset: number;
};

const PDFColorModeControl = ({
  colorMode,
  onColorModeChange,
}: PeekPdfColorControl) => {
  const t = useTranslations();

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("workspaces.pdf.adjustForDarkMode")}
        render={<Button size="icon-xs" variant="ghost" />}
        title={t("workspaces.pdf.adjustForDarkMode")}
      >
        <PdfColorModeIcon colorMode={colorMode} />
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
  atMax,
  atMin,
  onReset,
  onZoom,
  pdfColorControl,
  scaleOffset,
}: PeekPdfControlsProps) => (
  <>
    {/* The viewer's offset is measured from the fit scale, which is the
        level the control reads as 1. */}
    <ZoomControls
      atMax={atMax}
      atMin={atMin}
      level={1 + scaleOffset}
      onReset={onReset}
      onZoom={onZoom}
    />
    {pdfColorControl && (
      <>
        <Separator className="mx-0.5 h-4" orientation="vertical" />
        <PDFColorModeControl {...pdfColorControl} />
      </>
    )}
  </>
);

// ── DOCX peek viewer with zoom wiring ──────────────────

const PeekDocxViewer = ({
  activeSearchMatchIndex,
  buffer,
  fieldId,
  fileName,
  fitMode,
  onScrollTopChange,
  onSearchMatchSummaryChange,
  plugins,
  printActionsRef,
  scaleOffset,
  searchText,
  workspaceId,
}: {
  activeSearchMatchIndex: number;
  buffer: ArrayBuffer;
  fieldId: string;
  fileName: string;
  fitMode: "text-area" | "page";
  plugins: readonly Plugin[] | undefined;
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  onSearchMatchSummaryChange?:
    ((summary: SearchMatchSummary) => void) | undefined;
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
    fit:
      fitMode === "page"
        ? { type: "width", fitWidth: DOCX_PAGE_FIT_WIDTH, maxAutoZoom: 1 }
        : { type: "width" },
    scaleOffset,
  });
  // Stable ref callback so React doesn't detach/re-attach the fit-zoom
  // ResizeObserver every render.
  const composedContainerRef = useComposedRefs(containerRef, fitZoomRef);
  useDocxBlockScroll({ editorRef, fieldId });
  const searchTextKey =
    searchText === undefined ? undefined : searchTextQueryKey(searchText);

  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
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

  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- react/exhaustive-deps cannot see compiler memoization, and this value is an effect dependency
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

  const handleDocumentReady = () => {
    searchResultCacheRef.current = null;
    // Folio paints a read-only document before it builds the editor view, and
    // host plugins only see the document through that view.
    if (plugins !== undefined) {
      editorRef.current?.ensureEditorView({ focus: false });
    }
    scheduleSearchHighlight();
  };

  const handleEditorViewReady = () => {
    searchResultCacheRef.current = null;
    scheduleSearchHighlight();
  };

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
            analytics.captureError(error, {
              fingerprintKey: "PeekDocxViewer.print:failure",
              scope: {
                type: "handler",
                handlerId: "PeekDocxViewer.print:failure",
              },
            });
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
        accessibleName={fileName}
        autoOpenReviewSidebar={false}
        className="folio-docx-preview folio-peek h-full"
        documentBuffer={buffer}
        initialZoom={targetZoom}
        loadingIndicator={null}
        onCompatibilityChange={handleDocumentReady}
        onEditorViewReady={handleEditorViewReady}
        plugins={plugins}
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
      <DocumentMarkPageLayer pageId={pageId} />
    </>
  );
};
