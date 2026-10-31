import { panic } from "better-result";

import recoverMatterSteward from "@/api/handlers/workspaces/steward/update";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const matterStewardRecoveryScalingScenario = {
  name: "matter steward recovery refusal",
  definition: recoverMatterSteward,
  measure: async (
    context: Parameters<typeof recoverMatterSteward.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await recoverMatterSteward.handler(context);
      if (!(response instanceof HttpStatusResponse) || response.code !== 404) {
        panic("A healthy matter must refuse steward recovery");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
      };
    }),
};
