import { panic } from "better-result";

import prefillClientInvoice from "@/api/handlers/client-invoices/prefill";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

/** The mounted endpoint definition and the measured one must remain the same object. */
export const clientInvoicePrefillScalingScenario = {
  name: "client invoice prefill",
  definition: prefillClientInvoice,
  measure: async (
    context: Parameters<typeof prefillClientInvoice.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await prefillClientInvoice.handler(context);
      if (response instanceof HttpStatusResponse) {
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
