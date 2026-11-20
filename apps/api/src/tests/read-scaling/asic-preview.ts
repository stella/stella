import { panic } from "better-result";

import asicPreviewEndpoint from "@/api/handlers/files/asic";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const asicPreviewScalingScenario = {
  name: "ASiC file preview",
  definition: asicPreviewEndpoint,
  measure: async (context: Parameters<typeof asicPreviewEndpoint.handler>[0]) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await asicPreviewEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected ASiC document inventory");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.members.length,
      };
    }),
};
