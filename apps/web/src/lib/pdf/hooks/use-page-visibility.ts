import { useCallback, useRef } from "react";
import type { RefCallback, RefObject } from "react";

import { useThrottledCallback } from "use-debounce";

import { useLatestCallback } from "@/hooks/use-latest-callback";
import { PAGE_ID_ATTRIBUTE } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";

type UsePageVisibilityProps = {
  pageIds: string[];
  onPageChanged?: ((page: number) => void) | undefined;
};

type UsePageVisibilityResult = {
  containerRef: RefCallback<HTMLDivElement>;
  lastReportedPageRef: RefObject<number | null>;
};

/** Lazily initializes the ref-held ratios Map on first use instead of
 *  allocating a fresh (and discarded) instance on every render. */
const getOrCreateRatiosMap = (ref: {
  current: Map<string, number> | null;
}): Map<string, number> => {
  ref.current ??= new Map();
  return ref.current;
};

/**
 * Tracks which PDF pages are visible in the viewport
 * using IntersectionObserver. Reports the most visible
 * page via `onPageChanged` and updates the render
 * queue in the PDF store via `updateVisiblePages`.
 *
 * Returns `lastReportedPageRef` so the caller can
 * distinguish scroll-driven page changes from
 * intentional navigation.
 */
export const usePageVisibility = ({
  pageIds,
  onPageChanged,
}: UsePageVisibilityProps): UsePageVisibilityResult => {
  const updateVisiblePages = usePDFStore((s) => s.updateVisiblePages);

  const visiblePageRatiosRef = useRef<Map<string, number> | null>(null);
  const lastReportedPageRef = useRef<number | null>(null);

  const onPageChangedEvent = useLatestCallback((page: number) => {
    lastReportedPageRef.current = page;
    onPageChanged?.(page);
  });

  const throttledUpdate = useThrottledCallback(updateVisiblePages, 150);

  const containerRef = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || pageIds.length === 0) {
        return undefined;
      }

      const observer = new IntersectionObserver(
        (entries) => {
          const ratios = getOrCreateRatiosMap(visiblePageRatiosRef);

          for (const entry of entries) {
            const pageId = entry.target.getAttribute(PAGE_ID_ATTRIBUTE);
            if (!pageId) {
              continue;
            }

            if (entry.intersectionRatio >= 0.33) {
              ratios.set(pageId, entry.intersectionRatio);
            } else {
              ratios.delete(pageId);
            }
          }

          if (ratios.size === 0) {
            return;
          }

          const visiblePageIds = [...ratios.keys()];
          throttledUpdate(visiblePageIds);

          let nextPageId: string | undefined;
          let leadingRatio = 0;

          for (const [id, ratio] of ratios) {
            if (ratio >= leadingRatio) {
              leadingRatio = ratio;
              nextPageId = id;
            }
          }

          if (nextPageId !== undefined) {
            const idx = pageIds.indexOf(nextPageId);
            if (idx !== -1) {
              onPageChangedEvent(idx + 1);
            }
          }
        },
        { threshold: [0, 0.33, 0.66, 1] },
      );

      const pageElements = container.querySelectorAll<HTMLElement>(
        `[${PAGE_ID_ATTRIBUTE}]`,
      );

      for (const pageElement of pageElements) {
        observer.observe(pageElement);
      }

      const ratios = getOrCreateRatiosMap(visiblePageRatiosRef);

      return () => {
        observer.disconnect();
        throttledUpdate.cancel();
        ratios.clear();
      };
    },
    [pageIds, throttledUpdate, onPageChangedEvent],
  );

  return { containerRef, lastReportedPageRef };
};
