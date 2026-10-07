import { useRef } from "react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { queryViewError } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";

/** Optional reads keep their cached content and report failures without blocking it. */
export const useQueryViewError = <TData, TError>(
  view: QueryView<TData, TError>,
) => {
  const analytics = useAnalytics();
  const error = queryViewError(view);
  useExternalSyncEffect(() => {
    if (error !== undefined) {
      analytics.captureError(error);
    }
  }, [analytics, error]);
};

/** Dynamic query batches report each active failure once across renders. */
export const useQueryViewErrors = <TData, TError>(
  views: readonly QueryView<TData, TError>[],
) => {
  const analytics = useAnalytics();
  const reportedErrors = useRef(new Set<TError>());
  useExternalSyncEffect(() => {
    const currentErrors = new Set<TError>();
    for (const view of views) {
      const error = queryViewError(view);
      if (error === undefined || currentErrors.has(error)) {
        continue;
      }
      currentErrors.add(error);
      if (!reportedErrors.current.has(error)) {
        analytics.captureError(error);
      }
    }
    reportedErrors.current = currentErrors;
  }, [analytics, views]);
};
