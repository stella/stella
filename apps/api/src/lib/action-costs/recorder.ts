import { Result, TaggedError } from "better-result";

import { env } from "@/api/env";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { emitActionCostDropMetric } from "@/api/lib/observability/request-metrics";

import { createObservationBuffer } from "./buffer";
import { parseActionCostRates } from "./config";
import type { ActionCostObservation, ActionCostRecorder } from "./context";

class ActionCostObservationError extends TaggedError(
  "ActionCostObservationError",
)<{
  message: string;
  dropped: number;
  cause?: unknown;
}> {}
const COST_FAILURE = failureSink({
  event: "action_cost.observation_dropped",
  expected: [],
});
const BUFFER_CAPACITY = 1024;
const WRITE_BATCH_SIZE = 64;
let recorder: ReturnType<typeof createRecorder> | undefined;

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

const createRecorder = () => {
  const estimates = parseActionCostRates(env.ACTION_COST_ESTIMATES);
  const rates = parseActionCostRates(env.ACTION_COST_CALL_RATES);
  for (const config of [estimates, rates]) {
    if (Result.isError(config)) {
      observeFailure(config.error, { sink: COST_FAILURE });
    }
  }
  const estimateValues = new Map(
    Object.entries(Result.isOk(estimates) ? estimates.value : {}),
  );
  const rateValues = new Map(
    Object.entries(Result.isOk(rates) ? rates.value : {}),
  );
  const buffer = createObservationBuffer({
    capacity: BUFFER_CAPACITY,
    batchSize: WRITE_BATCH_SIZE,
    write: async (batch: ActionCostObservation[]) => {
      const { writeActionCostObservations } = await import("./store");
      await writeActionCostObservations(batch);
    },
    onFailure: (cause, dropped) => reportDrop(dropped, cause),
    onOverflow: () => reportDrop(1),
  });
  return {
    ...buffer,
    estimate: (kind: string) => estimateValues.get(kind) ?? null,
    callRate: (kind: string) => rateValues.get(kind) ?? null,
  };
};

export const getActionCostRecorder = (): ActionCostRecorder | undefined => {
  if (!env.FEATURE_ACTION_COST_RECORDS) {
    return undefined;
  }
  recorder ??= createRecorder();
  return recorder;
};

export const flushActionCostRecords = async (): Promise<void> => {
  await recorder?.flush();
};

export const reportMissingActionCostIdentity = (): void => reportDrop(1);
