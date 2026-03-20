import { useEffect, useEffectEvent, useRef } from "react";

import { useThrottledCallback } from "use-debounce";

import { PAGE_ID_ATTRIBUTE } from "@/lib/pdf/consts";
import { usePDFStore } from "@/lib/pdf/pdf-context";

type UsePageVisibilityProps = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  pageIds: string[];
  onPageChanged?: ((page: number) => void) | undefined;
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
  containerRef,
  pageIds,
  onPageChanged,
}: UsePageVisibilityProps) => {
  const updateVisiblePages = usePDFStore((s) => s.updateVisiblePages);

  const visiblePageRatiosRef = useRef<Map<string, number>>(new Map());
  const lastReportedPageRef = useRef<number | null>(null);

  const onPageChangedEvent = useEffectEvent((page: number) => {
    lastReportedPageRef.current = page;
    onPageChanged?.(page);
  });

  const throttledUpdate = useThrottledCallback(updateVisiblePages, 150);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || pageIds.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const ratios = visiblePageRatiosRef.current;

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

    const ratios = visiblePageRatiosRef.current;

    return () => {
      observer.disconnect();
      throttledUpdate.cancel();
      ratios.clear();
    };
  }, [pageIds, containerRef, throttledUpdate]);

  return lastReportedPageRef;
};
