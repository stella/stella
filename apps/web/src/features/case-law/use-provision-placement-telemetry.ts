import { useRef } from "react";

import { TaggedError } from "better-result";

import type { ProvisionPlacementFailure } from "@stll/api-contract/provision-placement";

import type { DecisionReaderSurface } from "@/features/case-law/decision-reader-surfaces";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";

class ProvisionPlacementError extends TaggedError("ProvisionPlacementError")<{
  message: string;
  reason: ProvisionPlacementFailure["reason"];
  surface: DecisionReaderSurface;
}> {}

type ProvisionPlacementTelemetryOptions = {
  decisionId: string;
  failures: readonly ProvisionPlacementFailure[];
  surface: DecisionReaderSurface;
};

export const useProvisionPlacementTelemetry = ({
  decisionId,
  failures,
  surface,
}: ProvisionPlacementTelemetryOptions) => {
  const analytics = useAnalytics();
  const reported = useRef(new Set<string>());
  useExternalSyncEffect(() => {
    for (const { id, reason } of failures) {
      const key = JSON.stringify([decisionId, surface, id, reason]);
      if (reported.current.has(key)) {
        continue;
      }
      reported.current.add(key);
      analytics.captureError(
        new ProvisionPlacementError({
          message: `Stored provision placement failed: ${surface}/${reason}`,
          reason,
          surface,
        }),
      );
    }
  }, [analytics, decisionId, failures, surface]);
};
