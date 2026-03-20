import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

import { usePDFStore } from "@/lib/pdf/pdf-context";

type UsePDFExternalPageSyncArgs = {
  page: number | undefined;
  pageIds: string[];
  lastReportedPageRef: RefObject<number | null>;
};

export const usePDFExternalPageSync = ({
  page,
  pageIds,
  lastReportedPageRef,
}: UsePDFExternalPageSyncArgs) => {
  const setScrollTo = usePDFStore((s) => s.setScrollTo);
  const prevPageRef = useRef(page);

  useLayoutEffect(() => {
    if (page === prevPageRef.current) {
      return;
    }

    prevPageRef.current = page;

    if (
      page === undefined ||
      page === lastReportedPageRef.current ||
      pageIds.length === 0
    ) {
      return;
    }

    const targetPageId = pageIds.at(page - 1);
    if (targetPageId !== undefined) {
      setScrollTo({ pageId: targetPageId });
    }
  }, [page, pageIds, setScrollTo, lastReportedPageRef]);
};
