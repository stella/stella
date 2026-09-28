import { TelemetryError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const ANON_RESTORATION_CONFLICT_SINK = failureSink({
  event: "chat.anon_restoration_conflict",
  expected: [],
});

/**
 * Reports that a message's restorations named two originals for one
 * placeholder, without the values. `mergeAnonRestorations` counts these.
 */
export const reportAnonRestorationConflict = (): void => {
  observeFailure(
    new TelemetryError({
      message: "An anonymization placeholder named two originals",
    }),
    { sink: ANON_RESTORATION_CONFLICT_SINK },
  );
};
