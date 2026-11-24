import { panic } from "better-result";

import { cadesPreviewEndpoint } from "@/api/handlers/files/cades";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const cadesPreviewScalingScenario = {
  name: "CAdES file preview",
  definition: cadesPreviewEndpoint,
  measure: async (
    context: Parameters<typeof cadesPreviewEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await cadesPreviewEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected signed file metadata");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.layers.length,
      };
    }),
};
