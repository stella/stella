import { createContext, Suspense, use, useEffect, useState } from "react";
import type { PropsWithChildren } from "react";

import type { Result } from "better-result";
import { LRUCache } from "lru-cache";
import { GlobalWorkerOptions } from "pdfjs-dist";
import type { PageViewport, PDFPageProxy } from "pdfjs-dist";
// eslint-disable-next-line import/default -- Vite ?url import returns the asset URL as default export
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createStore, useStore } from "zustand";

import {
  DEFAULT_PAGE_BUFFER_SIZE,
  SCROLL_AREA_VIEWPORT_SELECTOR,
} from "@/lib/pdf/consts";
import { PDFErrorBoundary } from "@/lib/pdf/pdf-error-boundary";
import type { PDFViewerError } from "@/lib/pdf/pdf-errors";
import type { PDFDocument } from "@/lib/pdf/pdf-loader";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";
import { renderPage } from "@/lib/pdf/pdf-renderer";
import { captureScrollPosition } from "@/lib/pdf/utils";

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// ── Types ──────────────────────────────────────────

export type PageInfo = {
  proxy: PDFPageProxy;
  originalWidth: number;
  originalHeight: number;
  viewport: PageViewport;
};

export type RenderedPage = {
  canvas: HTMLCanvasElement;
  textLayerDiv: HTMLDivElement;
  viewport: PageViewport;
};

export type RenderPageResult = Result<RenderedPage, PDFViewerError>;

type ScrollTo = {
  pageId: string;
  justificationId?: string | undefined;
};

type PDFState = {
  buffer: ArrayBuffer | null;
  document: PDFDocument | null;
  pages: Map<string, PageInfo>;
  attachmentLabels: Map<string, string>;
  scale: number;
  fitToWidth: number | undefined;
  scaleOffset: number;
  containerWidth: number;
  scrollTo: ScrollTo | null;
  activePages: string[];
  renderPromises: Map<string, Promise<RenderPageResult>>;
};

type SetDocumentInput = {
  buffer: ArrayBuffer;
  document: PDFDocument;
};

type PDFActions = {
  setScrollTo: (scrollTo: ScrollTo | null) => void;
  setScaleOffset: (offset: number) => void;
  setDocument: (input: SetDocumentInput) => void;
  updateVisiblePages: (visiblePageIds: string[]) => void;
  isRenderPromiseStale: (
    pageId: string,
    renderPromise: Promise<RenderPageResult>,
  ) => boolean;
  rerenderAtScale: (effectiveScale: number) => void;
  updateContainerWidth: (
    containerWidth: number,
    container: HTMLElement,
  ) => void;
};

export type PDFStore = PDFState & PDFActions;

// ── Store factory ──────────────────────────────────

type CreatePDFStoreArgs = {
  startPage: number;
  scaleOffset: number;
  fitToWidth: number | undefined;
};

const createPDFStore = ({
  startPage,
  scaleOffset,
  fitToWidth,
}: CreatePDFStoreArgs) => {
  const lru = new LRUCache<string, true>({
    max: DEFAULT_PAGE_BUFFER_SIZE,
  });

  let renderAbort: AbortController = new AbortController();
  let originalPageWidth: number | null = null;

  const remapPageViewports = (
    pages: Map<string, PageInfo>,
    scale: number,
  ): Map<string, PageInfo> => {
    const pagesAtScale = new Map<string, PageInfo>();
    for (const [pageId, page] of pages.entries()) {
      const viewport = page.proxy.getViewport({ scale });
      pagesAtScale.set(pageId, {
        ...page,
        viewport,
      });
    }
    return pagesAtScale;
  };

  const buildRenderPromises = ({
    pageIds,
    pages,
    signal,
  }: {
    pageIds: Iterable<string>;
    pages: Map<string, PageInfo>;
    signal: AbortSignal;
  }): Map<string, Promise<RenderPageResult>> => {
    const renderPromises = new Map<string, Promise<RenderPageResult>>();
    for (const pageId of pageIds) {
      const pageInfo = pages.get(pageId);
      if (pageInfo) {
        renderPromises.set(
          pageId,
          renderPage(pageInfo.proxy, pageInfo.viewport, signal),
        );
      }
    }
    return renderPromises;
  };

  const refreshRenderedPagesAtScale = ({
    effectiveScale,
    updates,
  }: {
    effectiveScale: number;
    updates?: Partial<Pick<PDFState, "scale" | "scaleOffset">>;
  }) => {
    renderAbort.abort();
    renderAbort = new AbortController();

    const { pages, activePages } = store.getState();
    const pagesAtEffectiveScale = remapPageViewports(pages, effectiveScale);
    const nextRenderPromises = buildRenderPromises({
      pageIds: activePages,
      pages: pagesAtEffectiveScale,
      signal: renderAbort.signal,
    });

    store.setState({
      ...updates,
      pages: pagesAtEffectiveScale,
      renderPromises: nextRenderPromises,
    });
  };

  const store = createStore<PDFStore>((set, get) => ({
    buffer: null,
    document: null,
    pages: new Map(),
    attachmentLabels: new Map(),
    scale: 1,
    fitToWidth,
    scaleOffset,
    containerWidth: fitToWidth ?? 0,
    scrollTo: null,
    activePages: [],
    renderPromises: new Map(),

    setScrollTo: (scrollTo) => set({ scrollTo }),
    isRenderPromiseStale: (pageId, renderPromise) =>
      get().renderPromises.get(pageId) !== renderPromise,
    setScaleOffset: (nextScaleOffset) => {
      if (nextScaleOffset === get().scaleOffset) {
        return;
      }

      refreshRenderedPagesAtScale({
        effectiveScale: get().scale + nextScaleOffset,
        updates: { scaleOffset: nextScaleOffset },
      });
    },

    setDocument: ({ buffer, document }) => {
      if (get().buffer === buffer && get().document === document) {
        return;
      }

      renderAbort.abort();
      renderAbort = new AbortController();

      const firstPage = document.pages.values().next();
      const origPageWidth = firstPage.done
        ? null
        : firstPage.value.originalWidth;
      originalPageWidth = origPageWidth;

      const baseDocumentScale =
        fitToWidth !== undefined &&
        fitToWidth > 0 &&
        origPageWidth !== null &&
        origPageWidth > 0
          ? fitToWidth / origPageWidth
          : document.baseScale;

      const effectiveScale = baseDocumentScale + get().scaleOffset;
      const pagesAtEffectiveScale = remapPageViewports(
        document.pages,
        effectiveScale,
      );

      lru.clear();

      const orderedPageIds = document.pages.keys().toArray();
      const pageCount = orderedPageIds.length;
      const startIndex = Math.min(
        Math.max(0, startPage - 1),
        Math.max(0, pageCount - 1),
      );

      const seedCount = Math.min(DEFAULT_PAGE_BUFFER_SIZE, pageCount);

      // Spiral outward from the start page: [start, +1, -1, +2, -2, ...]
      // Pages are inserted in spiral order, so the outermost pages
      // (farthest from start) are the most recent LRU entries and
      // the start page is the oldest. When scrolling in either
      // direction, the farthest pages on the opposite side are
      // evicted first.
      const spiralIds: string[] = [];
      for (let offset = 0; spiralIds.length < seedCount; offset++) {
        if (offset === 0) {
          const id = orderedPageIds.at(startIndex);
          if (id !== undefined) {
            spiralIds.push(id);
          }
          continue;
        }
        const rightIdx = startIndex + offset;
        if (rightIdx < pageCount) {
          const id = orderedPageIds.at(rightIdx);
          if (id !== undefined) {
            spiralIds.push(id);
          }
        }
        const leftIdx = startIndex - offset;
        if (leftIdx >= 0) {
          const id = orderedPageIds.at(leftIdx);
          if (id !== undefined) {
            spiralIds.push(id);
          }
        }
      }

      for (const id of spiralIds) {
        lru.set(id, true);
      }

      const initialRenderPromises = buildRenderPromises({
        pageIds: spiralIds,
        pages: pagesAtEffectiveScale,
        signal: renderAbort.signal,
      });

      const startPageId = orderedPageIds.at(startIndex);

      set({
        buffer,
        document,
        pages: pagesAtEffectiveScale,
        attachmentLabels: document.attachmentLabels,
        scale: baseDocumentScale,
        activePages: lru.keys().toArray(),
        scrollTo:
          startPage > 1 && startPageId !== undefined
            ? { pageId: startPageId }
            : null,
        renderPromises: initialRenderPromises,
      });
    },

    updateVisiblePages: (visiblePageIds) => {
      const { pages } = get();
      const pageIds = Array.from(pages.keys());

      const expandedSet = new Set(visiblePageIds);
      for (const pageId of visiblePageIds) {
        const idx = pageIds.indexOf(pageId);
        if (idx === -1) {
          continue;
        }

        const prev = pageIds[idx - 1];
        if (prev !== undefined) {
          expandedSet.add(prev);
        }

        const next = pageIds[idx + 1];
        if (next !== undefined) {
          expandedSet.add(next);
        }
      }

      for (const pageId of expandedSet) {
        if (lru.has(pageId)) {
          lru.get(pageId);
        } else {
          lru.set(pageId, true);
        }
      }

      const newActivePages = lru.keys().toArray();
      const previousRenderPromises = get().renderPromises;
      const nextRenderPromises = new Map(previousRenderPromises);
      let renderPromisesChanged = false;

      const pageIdsToRender: string[] = [];
      for (const pageId of expandedSet) {
        if (!previousRenderPromises.has(pageId)) {
          pageIdsToRender.push(pageId);
        }
      }

      const addedRenderPromises = buildRenderPromises({
        pageIds: pageIdsToRender,
        pages,
        signal: renderAbort.signal,
      });
      if (addedRenderPromises.size > 0) {
        renderPromisesChanged = true;
      }
      for (const [pageId, promise] of addedRenderPromises.entries()) {
        nextRenderPromises.set(pageId, promise);
      }

      for (const pageId of nextRenderPromises.keys()) {
        if (!newActivePages.includes(pageId)) {
          nextRenderPromises.delete(pageId);
          renderPromisesChanged = true;
        }
      }

      if (!renderPromisesChanged) {
        set({ activePages: newActivePages });
        return;
      }

      set({
        activePages: newActivePages,
        renderPromises: nextRenderPromises,
      });
    },

    rerenderAtScale: (effectiveScale) => {
      refreshRenderedPagesAtScale({ effectiveScale });
    },

    updateContainerWidth: (containerWidth, container) => {
      set({ containerWidth });

      if (originalPageWidth === null || originalPageWidth === 0) {
        return;
      }

      const { scale: currentBaseScale, pages: currentPages } = get();
      const fitToWidthScale = containerWidth / originalPageWidth;

      if (currentBaseScale === fitToWidthScale) {
        return;
      }

      const scrollViewport = container.closest<HTMLElement>(
        SCROLL_AREA_VIEWPORT_SELECTOR,
      );
      const restoreScroll = scrollViewport
        ? captureScrollPosition(scrollViewport)
        : null;

      const pagesAtFitToWidthScale = remapPageViewports(
        currentPages,
        fitToWidthScale,
      );

      set({
        scale: fitToWidthScale,
        pages: pagesAtFitToWidthScale,
      });

      requestAnimationFrame(() => {
        restoreScroll?.();
      });
    },
  }));

  const destroy = () => {
    renderAbort.abort();
    lru.clear();
    originalPageWidth = null;
    store.setState({
      buffer: null,
      document: null,
      attachmentLabels: new Map(),
      renderPromises: new Map(),
      pages: new Map(),
      activePages: [],
      scrollTo: null,
    });
  };

  return { store, destroy };
};

type PDFStoreApi = ReturnType<typeof createPDFStore>["store"];

const PDFStoreContext = createContext<PDFStoreApi | null>(null);

export const usePDFStore = <T,>(selector: (state: PDFStore) => T): T => {
  const store = use(PDFStoreContext);
  if (!store) {
    throw new Error("usePDFStore must be used within PDFProvider");
  }
  return useStore(store, selector);
};

type PDFProviderProps = PropsWithChildren<{
  startPage: number;
  initialScaleOffset?: number | undefined;
  fitToWidth?: number | undefined;
  fallback?: PDFPageFallback | undefined;
}>;

export const PDFProvider = ({
  startPage,
  initialScaleOffset = 0,
  fitToWidth,
  children,
  fallback,
}: PDFProviderProps) => {
  const [{ store, destroy }] = useState(() =>
    createPDFStore({
      startPage,
      scaleOffset: initialScaleOffset,
      fitToWidth,
    }),
  );

  // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- mount-only cleanup
  useEffect(() => destroy, []);

  return (
    <PDFStoreContext value={store}>
      <PDFErrorBoundary fallback={fallback?.error}>
        <Suspense fallback={fallback?.suspense}>{children}</Suspense>
      </PDFErrorBoundary>
    </PDFStoreContext>
  );
};
