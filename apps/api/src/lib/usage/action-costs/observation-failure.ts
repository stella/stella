import { TaggedError } from "better-result";

import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitActionCostDropMetric } from "@/api/lib/observability/request-metrics";

import { createDropReporter } from "./drop-reporter";

class ActionCostObservationError extends TaggedError(
  "ActionCostObservationError",
)<{
  message: string;
  dropped: number;
  cause?: unknown;
}> {}
export const COST_FAILURE = failureSink({
  event: "action_cost.observation_dropped",
  expected: [],
});

const reportDrop = (dropped: number, cause?: unknown): void => {
  emitActionCostDropMetric(dropped);
  logger.warn("action_cost.observations_dropped", { dropped });
  observeFailure(
    new ActionCostObservationError({
      message: "Action cost observations were dropped",
      dropped,
      cause,
    }),
    { sink: COST_FAILURE },
  );
};
export const drops = createDropReporter({ report: reportDrop });

export const reportActionCostObservationFailure = (cause: unknown): void =>
  drops.add(1, cause);
