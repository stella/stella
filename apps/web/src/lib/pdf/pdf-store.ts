import { LRUCache } from "lru-cache";
import {
  getDocument,
  type PageViewport,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { DEFAULT_PAGE_BUFFER_SIZE } from "@/lib/pdf/consts";
import { getOrderedPages } from "@/lib/pdf/utils";

import "pdfjs-dist/build/pdf.worker.mjs";

import { getStorageKey } from "@/consts";

export const PDF_WIDTH = 768; // px, screen md

export type ScrollTo = {
  pageNumber: number;
  justificationId?: string;
};

export type PasswordRequest = {
  resolve: (password: string) => void;
  reject: () => void;
  reason: number;
};

type State = {
  invertPages: boolean;
  scale: number;
  scrollTo: Map<string, ScrollTo>;
  pdfs: Map<
    string,
    {
      document: PDFDocumentProxy;
      /** Extra documents from PDF Portfolio attachments. */
      attachmentDocuments?: PDFDocumentProxy[];
      pageIds: string[];
      /** Maps pageId → banner label for the first page of
       *  each attachment in a PDF Portfolio. */
      attachmentLabels?: Map<string, string>;
      /** True when the PDF is an XFA form. */
      isXfa?: boolean;
    }
  >;
  pages: Map<
    string,
    Map<
      string,
      {
        proxy: PDFPageProxy;
        originalWidth: number;
        originalHeight: number;
        viewport: PageViewport;
      }
    >
  >;
  renderMap: Map<
    string,
    {
      renderingOrder: string[];
      renderingPageIds: string[];
    }
  >;
  /**
   * Set of page IDs that currently have a rendered canvas.
   * Driven by the LRU page buffer; pages evicted from the
   * buffer are removed from this set, signalling the component
   * to clear its canvas.
   */
  renderedPages: Set<string>;
  /**
   * Set when pdfjs-dist requests a password for an encrypted
   * PDF. The dialog reads this to show/hide itself.
   */
  passwordRequest: PasswordRequest | null;
};

type SetPdfProps = {
  signal: AbortSignal;
  fileId: string;
  fileBuffer: ArrayBuffer;
  startPageNumber: number;
  scaleOffset: number;
};

type UpdateScaleProps = {
  fileId: string;
  scaleOffset: number;
  currentPageNumber?: number;
};

type Actions = {
  toggleInvertPages: () => void;
  setPdf: (props: SetPdfProps) => Promise<void>;
  cleanupPdf: (fileId: string) => Promise<void>;
  cleanupPdfs: () => Promise<void>;
  updateScale: (props: UpdateScaleProps) => void;
  advancePageRendering: (fileId: string, pageId: string) => void;
  setScrollTo: (fileId: string, scrollTo: ScrollTo) => void;
  consumeScrollTo: (fileId: string) => void;
  updateVisiblePages: (fileId: string, visiblePageIds: string[]) => void;
  submitPassword: (password: string) => void;
  cancelPassword: () => void;
};

/**
 * Per-file LRU caches that track which pages have rendered
 * canvases. Lives outside Zustand because LRUCache is mutable
 * and fires dispose callbacks synchronously.
 */
const pageBuffers = new Map<string, LRUCache<string, true>>();

/**
 * Per-file arrays collecting page IDs evicted by the LRU
 * during a single buffer.set() call. Read and cleared by
 * advancePageRendering so all state changes happen in one
 * set(). Keyed per-file to prevent concurrent PDF loads from
 * leaking evictions across files.
 */
const pendingEvictions = new Map<string, string[]>();

const getOrCreateBuffer = (fileId: string): LRUCache<string, true> => {
  let buffer = pageBuffers.get(fileId);

  if (!buffer) {
    const evictions: string[] = [];
    pendingEvictions.set(fileId, evictions);

    buffer = new LRUCache<string, true>({
      max: DEFAULT_PAGE_BUFFER_SIZE,
      dispose: (_value, pageId) => {
        evictions.push(pageId);
      },
    });
    pageBuffers.set(fileId, buffer);
  }

  return buffer;
};

export const usePdfStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      invertPages: true,
      scale: 1,
      pdfs: new Map(),
      pages: new Map(),
      renderMap: new Map(),
      scrollTo: new Map(),
      renderedPages: new Set(),
      passwordRequest: null,

      toggleInvertPages: () => set((s) => ({ invertPages: !s.invertPages })),

      setPdf: async ({
        signal,
        fileId,
        fileBuffer,
        startPageNumber,
        scaleOffset,
      }) => {
        const state = get();

        const pdfs = new Map(state.pdfs);
        const pages = new Map(state.pages);
        const renderMap = new Map(state.renderMap);

        let document: PDFDocumentProxy | undefined =
          state.pdfs.get(fileId)?.document;

        if (!document || document.loadingTask.destroyed) {
          const loadingTask = getDocument({
            data: fileBuffer,
            enableXfa: true,
          });

          loadingTask.onPassword = (
            callback: (password: string) => void,
            reason: number,
          ) => {
            set({
              passwordRequest: {
                resolve: callback,
                reject: () => loadingTask.destroy(),
                reason,
              },
            });
          };

          try {
            document = await loadingTask.promise;
            // Password accepted (or wasn't needed);
            // clear any lingering request.
            set({ passwordRequest: null });
          } catch (error) {
            await loadingTask.destroy();
            throw error;
          }
        }

        const attachmentDocuments: PDFDocumentProxy[] = [];

        try {
          const pageIds: string[] = [];
          const documentPages: Promise<{
            id: string;
            proxy: PDFPageProxy;
          }>[] = [];

          // Check for PDF Portfolio (Collection) with
          // embedded file attachments.
          const attachments = await document.getAttachments();
          const pdfAttachments = attachments
            ? Object.values(attachments).filter(
                (
                  a,
                ): a is {
                  content: Uint8Array;
                  filename: string;
                } =>
                  typeof a === "object" &&
                  a !== null &&
                  "content" in a &&
                  "filename" in a &&
                  typeof a.filename === "string" &&
                  a.filename.toLowerCase().endsWith(".pdf"),
              )
            : [];

          const isPortfolio =
            pdfAttachments.length > 0 && document.numPages <= 1;

          const attachmentLabels = new Map<string, string>();

          if (isPortfolio) {
            // Skip the cover page; load each embedded PDF.
            let pageCounter = 1;
            let attIndex = 1;
            for (const att of pdfAttachments) {
              const attDoc = await getDocument({
                data: att.content,
                enableXfa: true,
              }).promise;
              attachmentDocuments.push(attDoc);

              const firstPageId = `${fileId}-${pageCounter}`;
              attachmentLabels.set(firstPageId, `${attIndex}. ${att.filename}`);

              for (let i = 1; i <= attDoc.numPages; i++) {
                const pageId = `${fileId}-${pageCounter}`;
                pageIds.push(pageId);
                documentPages.push(
                  attDoc.getPage(i).then((proxy) => ({ id: pageId, proxy })),
                );
                pageCounter++;
              }
              attIndex++;
            }
          } else {
            for (let i = 1; i <= document.numPages; i++) {
              const pageId = `${fileId}-${i}`;
              pageIds.push(pageId);
              documentPages.push(
                document.getPage(i).then((proxy) => ({ id: pageId, proxy })),
              );
            }
          }

          const pagesResult = await Promise.all(documentPages);

          if (pagesResult.length === 0) {
            throw new Error("PDF has no renderable pages");
          }

          // Detect XFA forms (check the first page).
          let isXfa = false;
          if (!isPortfolio) {
            try {
              const xfaHtml = await pagesResult[0].proxy.getXfa();
              isXfa = !!xfaHtml;
            } catch {
              // Not an XFA form.
            }
          }

          pdfs.set(fileId, {
            document,
            attachmentDocuments:
              attachmentDocuments.length > 0 ? attachmentDocuments : undefined,
            pageIds,
            attachmentLabels:
              attachmentLabels.size > 0 ? attachmentLabels : undefined,
            isXfa,
          });

          const firstPage = pagesResult[0];
          if (!firstPage) {
            throw new Error("PDF has no renderable pages");
          }
          const firstPageViewport = firstPage.proxy.getViewport({ scale: 1 });
          const scale = PDF_WIDTH / firstPageViewport.width;

          pages.set(
            fileId,
            new Map(
              pagesResult.map((page) => {
                const initialViewport = page.proxy.getViewport({
                  scale: 1,
                });
                const viewport = page.proxy.getViewport({
                  scale: scale + scaleOffset,
                });

                return [
                  page.id,
                  {
                    proxy: page.proxy,
                    originalWidth: initialViewport.width,
                    originalHeight: initialViewport.height,
                    viewport,
                  },
                ];
              }),
            ),
          );

          const reordered = getOrderedPages(pageIds, startPageNumber - 1);
          // Only queue enough pages to fill the buffer;
          // further rendering is scroll-driven via
          // updateVisiblePages.
          renderMap.set(fileId, {
            renderingOrder: reordered.items.slice(
              0,
              DEFAULT_PAGE_BUFFER_SIZE - reordered.immediatePages.length,
            ),
            renderingPageIds: reordered.immediatePages,
          });

          // Reset the buffer for this file
          const existingBuffer = pageBuffers.get(fileId);
          if (existingBuffer) {
            existingBuffer.clear();
          }

          // don't commit the state if the abort signal is aborted
          signal.throwIfAborted();

          set({
            scale,
            pdfs,
            pages,
            renderMap,
          });
        } catch (error) {
          // always destroy the current document, rerender will just create a new one
          await document.destroy();
          await Promise.allSettled(attachmentDocuments.map((d) => d.destroy()));

          if (error instanceof Error && error.name === "AbortError") {
            return;
          }

          throw error;
        }
      },
      cleanupPdf: async (fileId) => {
        const state = get();
        const pdf = state.pdfs.get(fileId);

        if (!pdf) {
          return;
        }

        const pdfs = new Map(state.pdfs);
        const pages = new Map(state.pages);
        const renderMap = new Map(state.renderMap);
        const renderedPages = new Set(state.renderedPages);

        pdfs.delete(fileId);
        pages.delete(fileId);
        renderMap.delete(fileId);

        const buffer = pageBuffers.get(fileId);
        if (buffer) {
          buffer.clear();
          pageBuffers.delete(fileId);
        }
        pendingEvictions.delete(fileId);

        // Remove rendered page IDs belonging to this file
        for (const pageId of renderedPages) {
          if (pageId.startsWith(`${fileId}-`)) {
            renderedPages.delete(pageId);
          }
        }

        set({ pdfs, pages, renderMap, renderedPages });

        if (!pdf.document.loadingTask.destroyed) {
          await pdf.document.destroy();
        }

        // Destroy attachment documents from PDF Portfolios
        if (pdf.attachmentDocuments) {
          await Promise.allSettled(
            pdf.attachmentDocuments.map((d) =>
              d.loadingTask.destroyed ? null : d.destroy(),
            ),
          );
        }
      },
      cleanupPdfs: async () => {
        const state = get();
        const pdfs = new Map(state.pdfs);
        const pdfValues = Array.from(pdfs.values());
        const pages = new Map(state.pages);
        const renderMap = new Map(state.renderMap);

        pdfs.clear();
        pages.clear();
        renderMap.clear();

        // Clear all page buffers
        for (const [fId, buffer] of pageBuffers) {
          buffer.clear();
          pageBuffers.delete(fId);
        }
        pendingEvictions.clear();

        // commit the changes instantly, otherwise setPdf can be blocked by the cleanupPdfs promise
        set({
          pdfs,
          pages,
          renderMap,
          renderedPages: new Set(),
          passwordRequest: null,
        });

        await Promise.allSettled(
          pdfValues.flatMap((pdf) => {
            const docs = [pdf.document, ...(pdf.attachmentDocuments ?? [])];
            return docs.map((d) =>
              d.loadingTask.destroyed ? null : d.destroy(),
            );
          }),
        );
      },
      updateScale: ({ fileId, scaleOffset, currentPageNumber = 1 }) =>
        set((s) => {
          const pages = new Map(s.pages);
          const renderMap = new Map(s.renderMap);
          const filePages = pages.get(fileId);
          const fileRenderMap = renderMap.get(fileId);

          if (!filePages || !fileRenderMap) {
            return s;
          }

          const pageIds: string[] = [];

          for (const [pageId, page] of filePages.entries()) {
            pageIds.push(pageId);

            const viewport = page.viewport.clone({
              scale: s.scale + scaleOffset,
            });

            filePages.set(pageId, {
              ...page,
              viewport,
            });
          }

          pages.set(fileId, filePages);

          const reordered = getOrderedPages(pageIds, currentPageNumber - 1);

          // Clear the buffer so all pages re-render at new scale
          const buffer = pageBuffers.get(fileId);
          if (buffer) {
            buffer.clear();
          }

          renderMap.set(fileId, {
            renderingOrder: reordered.items.slice(
              0,
              DEFAULT_PAGE_BUFFER_SIZE - reordered.immediatePages.length,
            ),
            renderingPageIds: reordered.immediatePages,
          });

          return {
            pages,
            renderMap,
            renderedPages: new Set(
              Array.from(s.renderedPages).filter((id) => !filePages.has(id)),
            ),
          };
        }),
      advancePageRendering: (fileId, pageId) => {
        const state = get();
        const renderMap = new Map(state.renderMap);
        const fileRenderMap = renderMap.get(fileId);

        if (!fileRenderMap) {
          return;
        }

        const justRenderedPageId = pageId;

        // Push the just-rendered page into the LRU buffer.
        // If this evicts an old page, the dispose callback
        // pushes it to pendingEvictions (synchronously).
        const buffer = getOrCreateBuffer(fileId);
        buffer.set(justRenderedPageId, true);

        // Apply evictions and addition in a single set()
        // so the stale-snapshot problem doesn't occur.
        const renderedPages = new Set(state.renderedPages);
        const fileEvictions = pendingEvictions.get(fileId);
        if (fileEvictions) {
          for (const evictedId of fileEvictions) {
            renderedPages.delete(evictedId);
          }
          fileEvictions.length = 0;
        }
        renderedPages.add(justRenderedPageId);

        // Remove the finished page from the active set
        const renderingPageIds = fileRenderMap.renderingPageIds.filter(
          (id) => id !== justRenderedPageId,
        );

        // Pull the next unrendered page from the queue
        let candidate = fileRenderMap.renderingOrder.shift();
        while (candidate) {
          if (!renderedPages.has(candidate)) {
            renderingPageIds.push(candidate);
            break;
          }
          candidate = fileRenderMap.renderingOrder.shift();
        }

        renderMap.set(fileId, {
          renderingOrder: fileRenderMap.renderingOrder,
          renderingPageIds,
        });

        set({ renderMap, renderedPages });
      },
      updateVisiblePages: (fileId, visiblePageIds) => {
        const state = get();
        const buffer = pageBuffers.get(fileId);

        if (!buffer) {
          return;
        }

        // Expand visible set by ±1 page so adjacent pages
        // are pre-rendered before the user scrolls to them.
        const allPageIds = state.pdfs.get(fileId)?.pageIds;
        const expandedSet = new Set(visiblePageIds);

        if (allPageIds) {
          for (const pageId of visiblePageIds) {
            const idx = allPageIds.indexOf(pageId);
            if (idx === -1) {
              continue;
            }
            if (idx > 0) {
              expandedSet.add(allPageIds[idx - 1]);
            }
            if (idx < allPageIds.length - 1) {
              expandedSet.add(allPageIds[idx + 1]);
            }
          }
        }

        const currentRendering = state.renderMap.get(fileId)?.renderingPageIds;

        // Touch visible pages in the LRU so they move to
        // the "most recently used" end and don't get evicted,
        // and collect any that need re-rendering.
        const pagesNeedingRender: string[] = [];
        for (const pageId of expandedSet) {
          if (buffer.has(pageId)) {
            buffer.get(pageId);
          }
          if (
            !state.renderedPages.has(pageId) &&
            !currentRendering?.includes(pageId)
          ) {
            pagesNeedingRender.push(pageId);
          }
        }

        if (pagesNeedingRender.length === 0) {
          return;
        }

        const renderMap = new Map(state.renderMap);
        const fileRenderMap = renderMap.get(fileId);

        if (!fileRenderMap) {
          return;
        }

        // Remove these pages from the existing queue
        // (if present) and prepend them so they render
        // next.
        const queueSet = new Set(pagesNeedingRender);
        fileRenderMap.renderingOrder = fileRenderMap.renderingOrder.filter(
          (id) => !queueSet.has(id),
        );
        fileRenderMap.renderingOrder.unshift(...pagesNeedingRender);

        // If nothing is currently rendering, kick off
        // the next page from the queue.
        if (fileRenderMap.renderingPageIds.length === 0) {
          const next = fileRenderMap.renderingOrder.shift();
          if (next) {
            fileRenderMap.renderingPageIds = [next];
          }
        }

        renderMap.set(fileId, fileRenderMap);
        set({ renderMap });
      },
      submitPassword: (password) => {
        const { passwordRequest } = get();
        if (passwordRequest) {
          passwordRequest.resolve(password);
          set({ passwordRequest: null });
        }
      },
      cancelPassword: () => {
        const { passwordRequest } = get();
        if (passwordRequest) {
          passwordRequest.reject();
          set({ passwordRequest: null });
        }
      },
      setScrollTo: (fileId, scrollToPage) =>
        set((s) => {
          const scrollTo = new Map(s.scrollTo);
          scrollTo.set(fileId, scrollToPage);
          return { scrollTo };
        }),
      consumeScrollTo: (fileId) =>
        set((s) => {
          const scrollTo = new Map(s.scrollTo);
          scrollTo.delete(fileId);
          return { scrollTo };
        }),
    }),
    {
      version: 1,
      name: getStorageKey("pdf"),
      partialize: (state) => ({
        invertPages: state.invertPages,
      }),
      migrate: () => {
        return;
      },
    },
  ),
);
