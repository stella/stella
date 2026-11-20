import { panic } from "better-result";

import structuredDocumentEndpoint from "@/api/handlers/files/structured-document";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const structuredDocumentScalingScenario = {
  name: "structured document text preview",
  definition: structuredDocumentEndpoint,
  measure: async (
    context: Parameters<typeof structuredDocumentEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await structuredDocumentEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected a structured document text preview");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};
