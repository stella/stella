import { panic } from "better-result";

import certifiedEmailEndpoint from "@/api/handlers/files/certified-email";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const certifiedEmailScalingScenario = {
  name: "certified email text preview",
  definition: certifiedEmailEndpoint,
  measure: async (
    context: Parameters<typeof certifiedEmailEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await certifiedEmailEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected a certified email text preview");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};
