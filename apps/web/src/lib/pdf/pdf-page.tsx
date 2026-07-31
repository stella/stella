import { Suspense, use, useCallback, useDeferredValue } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Result } from "better-result";
import { useShallow } from "zustand/react/shallow";

import { Skeleton } from "@stll/ui/components/skeleton";

import {
  PAGE_ID_ATTRIBUTE,
  SCROLL_AREA_VIEWPORT_SELECTOR,
  TEXT_LAYER_ATTRIBUTE,
} from "@/lib/pdf/consts";
import { usePDFStore, usePDFStoreApi } from "@/lib/pdf/pdf-context";
import type { PDFScrollTo, RenderPageResult } from "@/lib/pdf/pdf-context";
import { PDFErrorBoundary } from "@/lib/pdf/pdf-error-boundary";
import {
  getPDFPageScrollTop,
  isPDFSearchMatchScrollRequest,
} from "@/lib/pdf/pdf-page-scroll.logic";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";
import { toPDFSearchViewportBox } from "@/lib/pdf/pdf-search";
import { getCenteredSearchMatchScrollTop } from "@/lib/search-match-navigation";

export type PDFPageSearchMatch = {
  boxes: readonly PDFSearchBox[];
  matchIndex: number;
};

export type PDFPageFallback = {
  suspense?: ReactNode | undefined;
  error?: ReactNode | undefined;
};

export type PDFPageProps = {
  pageId: string;
  activeSearchMatchIndex?: number | undefined;
  searchMatches?: readonly PDFPageSearchMatch[] | undefined;
  /** Render function instead of ReactNode so the
   *  reference stays stable across parent re-renders,
   *  letting PDFPage skip unnecessary renders. */
  renderOverlay?: ((pageId: string) => ReactNode) | undefined;
  fallback?: PDFPageFallback | undefined;
};

const EMPTY_SEARCH_MATCHES: readonly PDFPageSearchMatch[] = [];

export const PDFPage = ({
  pageId,
  activeSearchMatchIndex,
  searchMatches = EMPTY_SEARCH_MATCHES,
  renderOverlay,
  fallback,
}: PDFPageProps) => {
  const [page, scrollTo, setScrollTo, isActive, renderPromise] = usePDFStore(
    useShallow((s) => [
      s.pages.get(pageId),
      s.scrollTo,
      s.setScrollTo,
      s.activePages.includes(pageId),
      s.renderPromises.get(pageId),
    ]),
  );
  const deferredPromise = useDeferredValue(renderPromise);

  if (!page) {
    return null;
  }

  return (
    <div
      ref={(el) => {
        const shouldScrollToPage =
          scrollTo !== null && scrollTo.pageId === pageId;

        if (!el || !shouldScrollToPage) {
          return;
        }
        const scrollViewport = el.closest<HTMLElement>(
          SCROLL_AREA_VIEWPORT_SELECTOR,
        );
        if (scrollViewport) {
          scrollViewport.scrollTo({
            top: getPDFPageScrollTop({
              currentScrollTop: scrollViewport.scrollTop,
              pageTop: el.getBoundingClientRect().top,
              viewportTop: scrollViewport.getBoundingClientRect().top,
            }),
          });
        }
        if (scrollTo.target === undefined) {
          setScrollTo(null);
        }
      }}
      {...{ [PAGE_ID_ATTRIBUTE]: pageId }}
      className="relative mx-auto border-transparent"
      style={{
        "--total-scale-factor": "var(--scale-factor)",
        backgroundColor: "var(--document-preview-page, var(--background))",
        width: `round(down, var(--total-scale-factor) * ${page.originalWidth}px, var(--scale-round-x))`,
        height: `round(down, var(--total-scale-factor) * ${page.originalHeight}px, var(--scale-round-y))`,
      }}
    >
      <PDFErrorBoundary fallback={fallback?.error ?? null}>
        <Suspense fallback={fallback?.suspense ?? <PDFPageSkeleton />}>
          {isActive && deferredPromise && (
            <>
              <PDFPageContent pageId={pageId} renderPromise={deferredPromise} />
              <PDFSearchHighlights
                activeMatchIndex={activeSearchMatchIndex}
                matches={searchMatches}
                pageId={pageId}
              />
              {renderOverlay?.(pageId)}
            </>
          )}
        </Suspense>
      </PDFErrorBoundary>
    </div>
  );
};

const PDFPageSkeleton = () => (
  <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
);

type PDFPageContentProps = {
  pageId: string;
  renderPromise: Promise<RenderPageResult>;
};

const PDFPageContent = ({ pageId, renderPromise }: PDFPageContentProps) => {
  const isRenderPromiseStale = usePDFStore((s) => s.isRenderPromiseStale);
  const result = use(renderPromise);

  if (Result.isError(result)) {
    if (result.error.code === "CANCELLED") {
      return null;
    }
    throw result.error;
  }

  const rendered = result.value;

  return (
    <>
      <div
        ref={(el) => {
          if (!el) {
            return undefined;
          }

          el.append(rendered.canvas);

          return () => {
            el.innerHTML = "";
            if (isRenderPromiseStale(pageId, renderPromise)) {
              rendered.canvas.width = 0;
              rendered.canvas.height = 0;
            }
          };
        }}
        className="size-full overflow-hidden"
        style={{ filter: "var(--pdf-page-filter, none)" }}
      />
      <div
        ref={(el) => {
          if (!el) {
            return undefined;
          }

          rendered.textLayerDiv.setAttribute(TEXT_LAYER_ATTRIBUTE, pageId);
          el.append(rendered.textLayerDiv);

          return () => {
            el.innerHTML = "";
          };
        }}
        className="[&_span::selection]:bg-foreground/25 [&_br]:absolute [&_br]:z-1 [&_br]:origin-top-left [&_br]:cursor-text [&_br]:whitespace-pre [&_br]:text-transparent [&_br::selection]:bg-transparent [&_span]:absolute [&_span]:z-1 [&_span]:origin-top-left [&_span]:cursor-text [&_span]:whitespace-pre [&_span]:text-transparent"
      />
    </>
  );
};

type PDFSearchHighlightsProps = {
  activeMatchIndex?: number | undefined;
  matches: readonly PDFPageSearchMatch[];
  pageId: string;
};

const PDFSearchHighlights = ({
  activeMatchIndex,
  matches,
  pageId,
}: PDFSearchHighlightsProps) => {
  const viewport = usePDFStore((state) => state.pages.get(pageId)?.viewport);
  const scrollTo = usePDFStore((state) => state.scrollTo);

  if (!viewport || matches.length === 0) {
    return null;
  }

  return (
    <div
      aria-hidden={true}
      className="pointer-events-none absolute inset-0 z-2"
      data-search-highlight-layer={true}
    >
      {matches.flatMap((match) =>
        match.boxes.map((box, boxIndex) => {
          const viewportBox = toPDFSearchViewportBox(box, viewport);
          if (
            !viewportBox ||
            viewportBox.width <= 0 ||
            viewportBox.height <= 0
          ) {
            return null;
          }
          const isActive = match.matchIndex === activeMatchIndex;

          return (
            <PDFSearchHighlightBox
              boxIndex={boxIndex}
              isActive={isActive}
              key={`${match.matchIndex}:${box.x}:${box.y}:${box.width}:${box.height}`}
              matchIndex={match.matchIndex}
              pageId={pageId}
              scrollTo={scrollTo}
              style={viewportBox}
            />
          );
        }),
      )}
    </div>
  );
};

type PDFSearchHighlightBoxProps = {
  boxIndex: number;
  isActive: boolean;
  matchIndex: number;
  pageId: string;
  scrollTo: PDFScrollTo | null;
  style: CSSProperties;
};

const PDFSearchHighlightBox = ({
  boxIndex,
  isActive,
  matchIndex,
  pageId,
  scrollTo,
  style,
}: PDFSearchHighlightBoxProps) => {
  const store = usePDFStoreApi();
  const shouldCenter =
    boxIndex === 0 &&
    isActive &&
    isPDFSearchMatchScrollRequest({ matchIndex, pageId, scrollTo });
  const highlightRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || !shouldCenter) {
        return;
      }

      // The page ref first aligns the requested page. Centre the match in the
      // following frame, using post-alignment geometry, and consume only the
      // same request so a newer citation/anonymization jump cannot be cleared.
      requestAnimationFrame(() => {
        if (
          !element.isConnected ||
          element.dataset["active"] !== "true" ||
          !isPDFSearchMatchScrollRequest({
            matchIndex,
            pageId,
            scrollTo: store.getState().scrollTo,
          })
        ) {
          return;
        }
        const scrollViewport = element.closest<HTMLElement>(
          SCROLL_AREA_VIEWPORT_SELECTOR,
        );
        if (!scrollViewport) {
          return;
        }
        const containerRect = scrollViewport.getBoundingClientRect();
        const matchRect = element.getBoundingClientRect();
        scrollViewport.scrollTo({
          top: getCenteredSearchMatchScrollTop({
            containerHeight: containerRect.height,
            containerTop: containerRect.top,
            currentScrollTop: scrollViewport.scrollTop,
            matchHeight: matchRect.height,
            matchTop: matchRect.top,
          }),
        });
        store.getState().setScrollTo(null);
      });
    },
    [matchIndex, pageId, shouldCenter, store],
  );

  return (
    <div
      ref={highlightRef}
      className={
        isActive
          ? "search-document-highlight bg-highlight/90 ring-highlight-foreground/30 absolute rounded-xs ring-1"
          : "search-document-highlight bg-highlight/45 absolute rounded-xs"
      }
      data-active={isActive ? "true" : undefined}
      data-search-highlight={true}
      data-search-match-index={matchIndex}
      style={style}
    />
  );
};
