import { useRef } from "react";

import type { UseQueryResult } from "@tanstack/react-query";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { queryView, queryViewError } from "@/lib/query-view.logic";
import type { QueryView, QueryViewOptions } from "@/lib/query-view.logic";

export const useQueryView = <TData, TError>(
  query: UseQueryResult<TData, TError>,
  options?: QueryViewOptions<TData>,
): QueryView<TData, TError> => queryView(query, options);

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
