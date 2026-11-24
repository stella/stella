import { panic } from "better-result";

import { mailboxPreviewEndpoint } from "@/api/handlers/files/mailbox";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const mailboxScalingScenario = {
  name: "Mailbox preview",
  definition: mailboxPreviewEndpoint,
  measure: async (
    context: Parameters<typeof mailboxPreviewEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await mailboxPreviewEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected a mailbox's messages");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};
