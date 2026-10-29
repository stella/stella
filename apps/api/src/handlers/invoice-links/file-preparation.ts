import { Result } from "better-result";

import { loadLinkedInvoiceData } from "@/api/handlers/invoice-links/document";
import type { buildLinkedEInvoice } from "@/api/handlers/invoice-links/e-invoice";
import type { InvoiceLinkCaller } from "@/api/handlers/invoice-links/link-access";
import {
  invoiceDocumentError,
  invoicePdfFileName,
  renderInvoiceDocumentPdf,
} from "@/api/handlers/invoices/pdf/document";
import type { InvoicePdfRenderer } from "@/api/handlers/invoices/pdf/document";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const INVOICE_LINK_FILES = ["pdf", "e_invoice"] as const;
export type InvoiceLinkFile = (typeof INVOICE_LINK_FILES)[number];

type PreparedInvoiceFile = {
  body: Uint8Array;
  contentType: string;
  fileName: string;
  workspaceId: InvoiceLinkCaller["workspaceIds"][number] | null;
};
type PrepareLinkedInvoiceFileOptions = {
  caller: InvoiceLinkCaller;
  file: InvoiceLinkFile;
  buildEInvoice: typeof buildLinkedEInvoice;
  renderInvoice: InvoicePdfRenderer;
};

/** Read the authorized document, release the transaction, then render before the final delivery gate. */
export const prepareLinkedInvoiceFile = async ({
  caller,
  file,
  buildEInvoice,
  renderInvoice,
}: PrepareLinkedInvoiceFileOptions): Promise<Result<
  PreparedInvoiceFile,
  HandlerError
> | null> => {
  const linked = await caller.db.scoped({
    organizationId: caller.organizationId,
    userId: null,
    workspaceIds: caller.workspaceIds,
  })(async (tx) => await loadLinkedInvoiceData(tx, caller));
  if (linked === null) {
    return null;
  }
  const { document } = linked;
  const unavailable = invoiceDocumentError(document);
  if (unavailable !== null) {
    return Result.err(unavailable);
  }
  const workspaceId = document.invoice.workspaceId;
  if (file === "pdf") {
    const pdf = await renderInvoiceDocumentPdf(document, renderInvoice);
    return pdf.map((body) => ({
      body,
      contentType: PDF_MIME_TYPE,
      fileName: invoicePdfFileName(document.invoice),
      workspaceId,
    }));
  }
  const eInvoice = await buildEInvoice(linked);
  if (eInvoice.isErr()) {
    return Result.err(eInvoice.error);
  }
  if (eInvoice.value === null) {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "This invoice has no e-invoice file.",
      }),
    );
  }
  return Result.ok({
    body: eInvoice.value.body,
    contentType: eInvoice.value.contentType,
    fileName: eInvoice.value.fileName,
    workspaceId,
  });
};
