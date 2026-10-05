import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { INVOICE_STATUS } from "@/api/db/schema";
import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { readInvoiceDocumentLines } from "@/api/handlers/invoices/invoice-lines";
import { renderInvoicePdf } from "@/api/handlers/invoices/pdf/render";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  extractFormattingLocale,
  extractLangFromRequest,
} from "@/api/lib/locale";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const EXPORT_URL_TTL_SECONDS = 300;

// permissions-exempt: rendering a temporary copy needs the same matter read
// permission as the invoice; it does not modify the invoice.
export const createInvoicePdfExport = (writeObject = writeS3ObjectWithRetry) =>
  createSafeHandler(
    {
      contentDelivery: { type: "audited" },
      description:
        "Download an invoice, advance invoice or credit note as PDF, including its parties, lines, VAT breakdown and payment QR. Drafts have no document number. Returns a short-lived downloadUrl, fileName and expiresAt; hand the URL to the user without reading the file bytes.",
      permissions: { workspace: ["read"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      featureAccess: { featureId: "time-billing", type: "required" },
      access: "write",
      mcp: {
        type: "capability",
        reason: "billing_admin",
        consumesServices: false,
      },
      params: workspaceParams({ invoiceId: tSafeId("invoice") }),
      realtime: noResourceSetUpdates(
        "Stores a generated PDF download; nothing a web view lists changes.",
      ),
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
      const amounts = yield* readInvoiceDocumentLines(loaded.invoice);
      const rendered = yield* Result.await(
        Result.tryPromise(
          async () =>
            await renderInvoicePdf({
              ...loaded,
              invoice: {
                ...loaded.invoice,
                lines: amounts.lines.map((line) => ({
                  description: line.description,
                  quantity: line.quantity,
                  unit: line.unit,
                  unitPrice: line.unitPrice,
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
      const number =
        loaded.invoice.status === INVOICE_STATUS.DRAFT
          ? "draft"
          : loaded.invoice.invoiceNumber;
      const fileName = sanitizeFilenamePreservingExtension(
        `invoice-${number ?? loaded.invoice.id}.pdf`,
      );
      const key = `exports/${session.activeOrganizationId}/${workspaceId}/invoices/${loaded.invoice.id}/${Bun.randomUUIDv7()}.pdf`;
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await writeObject(
              { contentType: PDF_MIME_TYPE, data: body, key },
              { type: "lifecycle-prefix", prefix: "exports/" },
            ),
          catch: (cause) =>
            new HandlerError({
              status: 502,
              message: "The invoice PDF could not be stored.",
              cause,
            }),
        }),
      );
      const downloadUrl = yield* Result.await(
        safeDb(
          async (tx) =>
            await auditedPresignDownload({
              tx,
              recordAuditEvent,
              resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
              resourceId: loaded.invoice.id,
              s3Key: key,
              s3Keyspace: "exports",
              expiresInSeconds: EXPORT_URL_TTL_SECONDS,
              fileName,
              organizationId: session.activeOrganizationId,
              workspaceId,
              metadata: { format: "pdf" },
            }),
        ),
      );
      return Result.ok({
        downloadUrl,
        fileName,
        expiresAt: Temporal.Now.instant()
          .add({ seconds: EXPORT_URL_TTL_SECONDS })
          .toString(),
      });
    },
  );

export default createInvoicePdfExport();
