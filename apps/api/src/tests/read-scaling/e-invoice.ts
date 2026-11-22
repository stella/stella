import { panic } from "better-result";

import {
  eInvoiceAttachmentEndpoint,
  eInvoicePreviewEndpoint,
} from "@/api/handlers/files/e-invoice";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";

export const eInvoicePreviewScalingScenario = {
  name: "structured invoice preview",
  definition: eInvoicePreviewEndpoint,
  measure: async (
    context: Parameters<typeof eInvoicePreviewEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await eInvoicePreviewEndpoint.handler(context);
      if (response instanceof HttpStatusResponse) {
        return panic("Expected a structured invoice preview");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows:
          response.type === "invoice" ? response.invoice.invoices.length : 1,
      };
    }),
};

export const eInvoiceAttachmentScalingScenario = {
  name: "structured invoice attachment",
  definition: eInvoiceAttachmentEndpoint,
  measure: async (
    context: Parameters<typeof eInvoiceAttachmentEndpoint.handler>[0],
  ) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await eInvoiceAttachmentEndpoint.handler(context);
      if (!(response instanceof Response) || !response.ok) {
        return panic("Expected an invoice attachment");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: (await response.arrayBuffer()).byteLength,
        rows: 1,
      };
    }),
};
