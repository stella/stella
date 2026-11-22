import { panic } from "better-result";

import emailReadingEndpoint from "@/api/handlers/files/email-reading";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const emailReadingScalingScenario = {
  name: "email text reading",
  definition: emailReadingEndpoint,
  measure: async (
    context: Parameters<typeof emailReadingEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await emailReadingEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected an email text reading");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};
