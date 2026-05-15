import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { PagedEditorRef } from "../../paged-editor/PagedEditor";
import type { ScrollPageInfo } from "../scrollPageInfo";
import type { ViewportCenterZoomAnchor } from "../zoomScrollAnchor";
import {
  getScrollTopForZoomAnchor,
  getViewportCenterZoomAnchorForZoomChange,
} from "../zoomScrollAnchor";

const PAGE_INFO_FADE_MS = 600;
const PAGE_GAP = 24;
const PAGES_PADDING_TOP = 24;

export type UseZoomAndPageInfoArgs = {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  pagedEditorRef: RefObject<PagedEditorRef | null>;
  /** Initial zoom on mount. Subsequent changes do not apply. */
  initialZoom: number;
};

export type UseZoomAndPageInfoReturn = {
  zoom: number;
  /** Stable ref that mirrors `zoom` for use in callbacks that need the
   *  current zoom without re-binding (e.g., scroll handlers). */
  zoomRef: RefObject<number>;
  /**
   * Set a new zoom level. Captures the viewport center so the editor
   * re-anchors after the layout reflows.
   */
  setZoomWithViewportAnchor: (zoom: number) => void;
  scrollPageInfo: ScrollPageInfo;
  setScrollPageInfo: Dispatch<SetStateAction<ScrollPageInfo>>;
  /** Recompute current/total page indicators from the live scroll position. */
  updateScrollPageInfo: (scrollContainer: HTMLDivElement) => void;
  /** Hide the page indicator overlay after a short delay. */
  scheduleScrollPageInfoFade: () => void;
};

export function useZoomAndPageInfo({
  scrollContainerRef,
  pagedEditorRef,
  initialZoom,
}: UseZoomAndPageInfoArgs): UseZoomAndPageInfoReturn {
  const [zoom, setZoom] = useState(initialZoom);
  const zoomRef = useRef(zoom);
  const pendingZoomAnchorRef = useRef<ViewportCenterZoomAnchor | null>(null);

  const [scrollPageInfo, setScrollPageInfo] = useState<ScrollPageInfo>({
    currentPage: 1,
    totalPages: 1,
    visible: false,
  });
  const scrollFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleScrollPageInfoFade = useCallback(() => {
    if (scrollFadeTimerRef.current) {
      clearTimeout(scrollFadeTimerRef.current);
    }
    scrollFadeTimerRef.current = setTimeout(() => {
      setScrollPageInfo((prev) => ({ ...prev, visible: false }));
    }, PAGE_INFO_FADE_MS);
  }, []);

  const updateScrollPageInfo = useCallback(
    (scrollContainer: HTMLDivElement) => {
      const layout = pagedEditorRef.current?.getLayout();
      if (!layout || layout.pages.length === 0) {
        return;
      }

      const scrollTop = scrollContainer.scrollTop;
      const totalPages = layout.pages.length;
      const scaledViewportCenter = scrollTop + scrollContainer.clientHeight / 2;
      const viewportCenter =
        scaledViewportCenter / Math.max(zoomRef.current, Number.EPSILON);

      let accumulatedY = PAGES_PADDING_TOP;
      let currentPage = 1;
      for (let i = 0; i < layout.pages.length; i++) {
        // SAFETY: i is bounded by layout.pages.length
        const pageHeight = layout.pages[i]!.size.h;
        const pageEnd = accumulatedY + pageHeight;
        if (viewportCenter < pageEnd) {
          currentPage = i + 1;
          break;
        }
        accumulatedY = pageEnd + PAGE_GAP;
        currentPage = i + 2;
      }
      currentPage = Math.min(currentPage, totalPages);

      setScrollPageInfo({ currentPage, totalPages, visible: true });
    },
    [pagedEditorRef],
  );

  const setZoomWithViewportAnchor = useCallback(
    (nextZoom: number) => {
      const currentZoom = zoomRef.current;
      const scrollContainer = scrollContainerRef.current;
      const previousAnchor = pendingZoomAnchorRef.current;

      pendingZoomAnchorRef.current = scrollContainer
        ? getViewportCenterZoomAnchorForZoomChange({
            clientHeight: scrollContainer.clientHeight,
            currentZoom,
            nextZoom,
            pendingAnchor: previousAnchor,
            scrollTop: scrollContainer.scrollTop,
          })
        : null;

      if (currentZoom === nextZoom) {
        return;
      }
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    },
    [scrollContainerRef],
  );

  useLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    if (!anchor) {
      return;
    }
    pendingZoomAnchorRef.current = null;
    if (anchor.zoom === zoom) {
      return;
    }
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }
    const nextScrollTop = getScrollTopForZoomAnchor(anchor, zoom);
    scrollContainer.scrollTop = nextScrollTop;
    updateScrollPageInfo(scrollContainer);
    scheduleScrollPageInfoFade();
  }, [
    zoom,
    scheduleScrollPageInfoFade,
    updateScrollPageInfo,
    scrollContainerRef,
  ]);

  // Scroll-driven page indicator: re-attaches when the scroll container
  // mounts (after loading completes).
  const scrollContainerEl = scrollContainerRef.current;
  useEffect(() => {
    if (!scrollContainerEl) {
      return;
    }
    const handleScroll = () => {
      updateScrollPageInfo(scrollContainerEl);
      scheduleScrollPageInfoFade();
    };
    scrollContainerEl.addEventListener("scroll", handleScroll, {
      passive: true,
    });
    return () => {
      scrollContainerEl.removeEventListener("scroll", handleScroll);
      if (scrollFadeTimerRef.current) {
        clearTimeout(scrollFadeTimerRef.current);
      }
    };
  }, [scrollContainerEl, scheduleScrollPageInfoFade, updateScrollPageInfo]);

  return {
    zoom,
    zoomRef,
    setZoomWithViewportAnchor,
    scrollPageInfo,
    setScrollPageInfo,
    updateScrollPageInfo,
    scheduleScrollPageInfoFade,
  };
}
