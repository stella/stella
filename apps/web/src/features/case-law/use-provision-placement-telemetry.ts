import type { ProvisionPlacementFailure } from "@stll/api-contract/provision-placement";

import type { DecisionReaderSurface } from "@/features/case-law/decision-reader-surfaces";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import type { Analytics } from "@/lib/analytics/types";

type ProvisionPlacementTelemetryOptions = {
  decisionId: string;
  failures: readonly ProvisionPlacementFailure[];
  surface: DecisionReaderSurface;
};

// Rows already counted, per analytics client (one per page load) and
// decision/surface/reason. Owned here rather than by the mounted reader, so
// remounting a reader or reopening a decision never counts a row twice.
const countedRows = new WeakMap<Analytics, Map<string, Set<string>>>();

/**
 * Counts the stored citations a reader could not place. A gap is a data
 * outcome, not an exception: each decision, surface and reason sends one
 * event with the rows it newly covers, so the counts across a page load sum to
 * the distinct unplaced rows.
 */
export const useProvisionPlacementTelemetry = ({
  decisionId,
  failures,
  surface,
}: ProvisionPlacementTelemetryOptions) => {
  const analytics = useAnalytics();
  useExternalSyncEffect(() => {
    let counted = countedRows.get(analytics);
    if (counted === undefined) {
      counted = new Map();
      countedRows.set(analytics, counted);
    }
    const fresh = new Map<ProvisionPlacementFailure["reason"], number>();
    for (const { id, reason } of failures) {
      const key = JSON.stringify([decisionId, surface, reason]);
      let rows = counted.get(key);
      if (rows === undefined) {
        rows = new Set();
        counted.set(key, rows);
      }
      if (rows.has(id)) {
        continue;
      }
      rows.add(id);
      fresh.set(reason, (fresh.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of fresh) {
      analytics.captureProvisionPlacementGaps({ count, reason, surface });
    }
  }, [analytics, decisionId, failures, surface]);
};
