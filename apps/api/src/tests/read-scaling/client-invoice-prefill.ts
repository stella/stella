import { panic } from "better-result";
import { ElysiaCustomStatusResponse } from "elysia";

import prefillClientInvoice from "@/api/handlers/client-invoices/prefill";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

/** The mounted handler and the measured handler must remain the same object. */
export const clientInvoicePrefillScalingScenario = {
  name: "client invoice prefill",
  handler: prefillClientInvoice.handler,
  measure: async (
    context: Parameters<typeof prefillClientInvoice.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await prefillClientInvoice.handler(context);
      if (response instanceof ElysiaCustomStatusResponse) {
        panic("Client invoice prefill scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.matters.length,
        matterIds: response.matters.map(({ workspaceId }) => workspaceId),
      };
    }),
};
