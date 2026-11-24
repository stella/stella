import { panic } from "better-result";

import { signedDossierPreviewEndpoint } from "@/api/handlers/files/signed-dossier";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const signedDossierPreviewScalingScenario = {
  name: "Signed container preview",
  definition: signedDossierPreviewEndpoint,
  measure: async (
    context: Parameters<typeof signedDossierPreviewEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await signedDossierPreviewEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected a signed container inventory");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.documents.length,
      };
    }),
};
