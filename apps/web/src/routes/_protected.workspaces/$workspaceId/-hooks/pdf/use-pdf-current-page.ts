import { useLayoutEffect, useRef } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { produce } from "immer";
import { useThrottledCallback } from "use-debounce";

import { PAGE_NUMBER_ATTRIBUTE } from "@/lib/pdf/consts";
import { usePdfStore } from "@/lib/pdf/pdf-store";

type UseUpdateCurrentPageProps = {
  fileId: string;
  pageIds: string[] | undefined;
  containerRef: React.RefObject<HTMLDivElement | null>;
};

const getPageNumber = (element: Element) => {
  const pageNumberAttribute = element.getAttribute(PAGE_NUMBER_ATTRIBUTE);

  if (!pageNumberAttribute) {
    return null;
  }

  const pageNumber = +pageNumberAttribute;

  if (Number.isNaN(pageNumber)) {
    return null;
  }

  return pageNumber;
};

export const useUpdateCurrentPage = ({
  fileId,
  pageIds,
  containerRef,
}: UseUpdateCurrentPageProps) => {
  const router = useRouter();
  const initialPageRef = useRef<number | null>(
    router.state.location.search.file?.pageNumber ?? 1,
  );
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/pdf",
  });
  const visiblePageRatiosRef = useRef<Map<number, number>>(new Map());
  const updateVisiblePages = usePdfStore((s) => s.updateVisiblePages);

  // Throttle render-queue updates so the first scroll fires
  // immediately (no delay on slow scrolling) while fast
  // scrolling batches into one call per interval.
  const throttledUpdateVisiblePages = useThrottledCallback(
    updateVisiblePages,
    150,
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    const initialPage = initialPageRef.current;

    if (!container || !pageIds) {
      return;
    }

    const observer = new IntersectionObserver(
      async (entries) => {
        const ratios = visiblePageRatiosRef.current;

        for (const entry of entries) {
          const pageNumber = getPageNumber(entry.target);

          if (!pageNumber) {
            continue;
          }

          if (entry.intersectionRatio >= 0.33) {
            ratios.set(pageNumber, entry.intersectionRatio);
          } else {
            ratios.delete(pageNumber);
          }
        }

        if (ratios.size === 0) {
          return;
        }

        // Notify the page buffer about visible pages so it
        // can protect them from eviction and re-queue any
        // that were cleaned up. Throttled so fast scrolling
        // doesn't render pages only briefly in the viewport.
        const visiblePageIds = Array.from(ratios.keys()).map(
          (n) => `${fileId}-${n}`,
        );
        throttledUpdateVisiblePages(fileId, visiblePageIds);

        let nextPage: number | undefined;
        let leadingRatio = 0;

        for (const [pageNumber, ratio] of ratios) {
          if (ratio > leadingRatio || ratio === leadingRatio) {
            leadingRatio = ratio;
            nextPage = pageNumber;
          }
        }

        if (!nextPage) {
          return;
        }

        await navigate({
          replace: true,
          search: (prev) =>
            produce(prev, (s) => {
              if (!s.file?.fieldId) {
                return;
              }

              s.file.pageNumber = nextPage;
            }),
        });
      },
      {
        threshold: [0, 0.33, 0.66, 1],
      },
    );

    const pageElements = container.querySelectorAll<HTMLElement>(
      `[${PAGE_NUMBER_ATTRIBUTE}]`,
    );

    for (const pageElement of pageElements) {
      const pageNumber = getPageNumber(pageElement);

      if (initialPage && initialPage > 1 && pageNumber === initialPage) {
        initialPageRef.current = null;
        pageElement.scrollIntoView({ block: "start" });
      }

      observer.observe(pageElement);
    }

    return () => {
      observer.disconnect();
      throttledUpdateVisiblePages.cancel();
      visiblePageRatiosRef.current.clear();
    };
  }, [
    pageIds,
    containerRef.current,
    navigate,
    fileId,
    throttledUpdateVisiblePages,
  ]);
};
