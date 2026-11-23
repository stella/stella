import { panic } from "better-result";

import { signaturePreviewEndpoint } from "@/api/handlers/files/signature";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const signaturePreviewScalingScenario = {
  name: "Signature file preview",
  definition: signaturePreviewEndpoint,
  measure: async (
    context: Parameters<typeof signaturePreviewEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await signaturePreviewEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected signature metadata");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.type === "signature" ? response.signers.length : 0,
      };
    }),
};
