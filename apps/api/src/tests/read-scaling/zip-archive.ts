import { panic } from "better-result";

import { zipArchivePreviewEndpoint } from "@/api/handlers/files/zip-archive";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const zipArchiveScalingScenario = {
  name: "ZIP archive preview",
  definition: zipArchivePreviewEndpoint,
  measure: async (
    context: Parameters<typeof zipArchivePreviewEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await zipArchivePreviewEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected a ZIP archive's files");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};
