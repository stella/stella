import { panic } from "better-result";

import {
  signedDossierContentEndpoint,
  signedDossierPreviewEndpoint,
} from "@/api/handlers/files/signed-dossier";
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

export const signedDossierContentScalingScenario = {
  name: "Signed container PDF",
  definition: signedDossierContentEndpoint,
  measure: async (
    context: Parameters<typeof signedDossierContentEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await signedDossierContentEndpoint.handler(context);
      if (!(response instanceof Response) || !response.ok) {
        return panic("Expected a signed container PDF");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: (await response.arrayBuffer()).byteLength,
        rows: 1,
      };
    }),
};
