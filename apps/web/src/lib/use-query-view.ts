import { useRef } from "react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { ExceptionFingerprintKey } from "@/lib/analytics/exception-fingerprint";
import { useAnalytics } from "@/lib/analytics/provider";
import type { NotApiErrorEnvelope } from "@/lib/analytics/types";
import { queryViewError } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";

// The envelope guard sits on the parameter because a conditional constraint on
// TError itself is circular; `captureError<TError>` keeps the guarded
// intersection instead of re-inferring through it.

/** Optional reads keep their cached content and report failures without blocking it. */
export const useQueryViewError = <TData, TError>(
  view: QueryView<TData, TError & NotApiErrorEnvelope<TError>>,
  fingerprintKey: ExceptionFingerprintKey,
) => {
  const analytics = useAnalytics();
  const error = queryViewError(view);
  useExternalSyncEffect(() => {
    if (error !== undefined) {
      analytics.captureError<TError>(error, {
        fingerprintKey,
        scope: { type: "handler", handlerId: fingerprintKey },
      });
    }
  }, [analytics, error, fingerprintKey]);
};

/** Dynamic query batches report each active failure once across renders. */
export const useQueryViewErrors = <TData, TError>(
  views: readonly QueryView<TData, TError & NotApiErrorEnvelope<TError>>[],
  fingerprintKey: ExceptionFingerprintKey,
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
        analytics.captureError<TError>(error, {
          fingerprintKey,
          scope: { type: "handler", handlerId: fingerprintKey },
        });
      }
    }
    reportedErrors.current = currentErrors;
  }, [analytics, views, fingerprintKey]);
};
