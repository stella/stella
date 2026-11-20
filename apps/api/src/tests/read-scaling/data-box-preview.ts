import { panic } from "better-result";

import dataBoxEndpoint from "@/api/handlers/files/data-box";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const dataBoxPreviewScalingScenario = {
  name: "data-box file preview",
  definition: dataBoxEndpoint,
  measure: async (context: Parameters<typeof dataBoxEndpoint.handler>[0]) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await dataBoxEndpoint.handler(context);
      if (
        response instanceof HttpStatusResponse ||
        response.kind !== "message"
      ) {
        return panic("Expected the stored data-box message preview");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.files.length,
      };
    }),
};
