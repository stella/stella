import { Result } from "better-result";

import { env } from "@/api/env";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { observeFailure } from "@/api/lib/observability/observe-failure";

import { createObservationBuffer } from "./buffer";
import { parseActionCostRates } from "./config";
import type { ActionCostObservation, ActionCostRecorder } from "./context";
import { COST_FAILURE, drops } from "./observation-failure";

const BUFFER_CAPACITY = 1024;
const WRITE_BATCH_SIZE = 64;
let recorder: ReturnType<typeof createRecorder> | undefined;

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
      const { openOrganizationFileUsageDb } =
        await import("@/api/lib/db/maintenance-db");
      await writeActionCostObservations(openOrganizationFileUsageDb(), batch);
    },
    onFailure: (cause, dropped) => drops.add(dropped, cause),
    onOverflow: () => drops.add(1),
  });
  return {
    ...buffer,
    estimate: (kind: string) => estimateValues.get(kind) ?? null,
    callRate: (kind: string) => rateValues.get(kind) ?? null,
  };
};

export const getActionCostRecorder = (): ActionCostRecorder | undefined => {
  if (!isDeploymentFeatureEnabled("FEATURE_ACTION_COST_RECORDS")) {
    return undefined;
  }
  recorder ??= createRecorder();
  return recorder;
};

export const flushActionCostRecords = async (): Promise<void> => {
  drops.flush();
  await recorder?.flush();
  drops.flush();
};

export const reportMissingActionCostIdentity = (): void => drops.add(1);
