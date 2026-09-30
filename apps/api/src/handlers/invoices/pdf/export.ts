import { Result } from "better-result";

import { INVOICE_STATUS } from "@/api/db/schema";
import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { readInvoiceAmounts } from "@/api/handlers/invoices/invoice-lines";
import { renderInvoicePdf } from "@/api/handlers/invoices/pdf/render";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  extractFormattingLocale,
  extractLangFromRequest,
} from "@/api/lib/locale";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const exportInvoicePdf = createSafeHandler(
  {
    description:
      "Download an invoice, advance invoice or credit note as PDF, including its parties, lines, VAT breakdown and payment QR. Drafts have no document number. Returns file bytes, not JSON; invoices.list reads invoice data without producing the PDF.",
    permissions: { workspace: ["read"] },
    access: "read",
    mcp: { type: "capability", reason: "billing_admin" },
    transport: {
      type: "file-response",
      response: { mediaTypes: [PDF_MIME_TYPE] },
      alternative: {
        type: "none",
        reason:
          "the rendered PDF is a binary document; invoices.list exposes invoice data but does not produce the file",
      },
    },
    params: workspaceParams({ invoiceId: tSafeId("invoice") }),
  },
  async function* ({
    safeDb,
    workspaceId,
    session,
    params,
    request,
    recordAuditEvent,
  }) {
    const loaded = yield* Result.await(
      safeDb(async (tx) => {
        const invoice = await tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
            workspaceId: { eq: workspaceId },
            organizationId: { eq: session.activeOrganizationId },
          },
          with: INVOICE_DETAIL_RELATIONS,
        });
        if (!invoice) {
          return null;
        }
        const seller =
          invoice.sellerProfileId === null
            ? null
            : await tx.query.sellerProfiles.findFirst({
                where: {
                  id: { eq: invoice.sellerProfileId },
                  organizationId: { eq: session.activeOrganizationId },
                },
              });
        const original =
          invoice.originalInvoiceId === null
            ? null
            : await tx.query.invoices.findFirst({
                where: {
                  id: { eq: invoice.originalInvoiceId },
                  workspaceId: { eq: workspaceId },
                  organizationId: { eq: session.activeOrganizationId },
                },
                columns: { invoiceNumber: true },
              });
        return {
          invoice,
          seller: seller ?? null,
          originalNumber: original?.invoiceNumber ?? null,
        };
      }),
    );
    if (!loaded) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice not found" }),
      );
    }
    if (loaded.invoice.sellerProfileId !== null && loaded.seller === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Invoice seller profile is unavailable",
          hint: "Select an available seller profile before exporting the invoice.",
        }),
      );
    }
    if (
      loaded.invoice.documentType === "credit_note" &&
      loaded.originalNumber === null
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Original invoice number is unavailable",
          hint: "The credit note must reference an issued invoice in this matter.",
        }),
      );
    }
    const amounts = yield* readInvoiceAmounts(loaded.invoice);
    const rendered = yield* Result.await(
      Result.tryPromise(
        async () =>
          await renderInvoicePdf({
            ...loaded,
            invoice: {
              ...loaded.invoice,
              lines: amounts.lines.map((line) => ({
                description: line.description,
                netAmount: line.netAmountMinor,
                vatAmount: line.vatAmountMinor,
                grossAmount: line.grossAmountMinor,
                vatRateBps: line.vatRateBps,
                vatTreatment: line.vatTreatment,
              })),
            },
            totals: amounts.totals,
            locale: extractFormattingLocale(request),
            lang: extractLangFromRequest(request),
          }),
      ),
    );
    if (rendered.isErr()) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: rendered.error.message,
          hint: "Check the seller payment details and invoice dates before exporting.",
        }),
      );
    }
    const body = rendered.value;
    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
          resourceId: loaded.invoice.id,
          metadata: { format: "pdf" },
        });
      }),
    );
    const number =
      loaded.invoice.status === INVOICE_STATUS.DRAFT
        ? "draft"
        : loaded.invoice.invoiceNumber;
    return Result.ok(
      secureDocumentResponse({
        body: new Blob([body], { type: PDF_MIME_TYPE }),
        contentType: PDF_MIME_TYPE,
        disposition: "attachment",
        fileName: sanitizeFilenamePreservingExtension(
          `invoice-${number ?? loaded.invoice.id}.pdf`,
        ),
        contentLength: body.byteLength,
      }),
    );
  },
);

export default exportInvoicePdf;
