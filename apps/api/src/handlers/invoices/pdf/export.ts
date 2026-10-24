import { Result } from "better-result";

import { classifyFailure } from "@stll/errors";
import { Temporal } from "@stll/time";

import { ownerSyntheticSessionAuthorityReader } from "@/api/db/root";
import { INVOICE_STATUS } from "@/api/db/schema";
import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { readInvoiceDocumentLines } from "@/api/handlers/invoices/invoice-lines";
import { renderInvoiceWithTypst } from "@/api/handlers/invoices/pdf/typst/render-typst";
import { openTypstSession } from "@/api/handlers/invoices/pdf/typst/session";
import type { TypstRenderOutcome } from "@/api/handlers/invoices/pdf/typst/session";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const EXPORT_URL_TTL_SECONDS = 300;
const invoiceTypstSession = openTypstSession();

const invoiceRenderError = (cause: unknown) => {
  if (cause instanceof HandlerError) {
    return cause;
  }
  return new HandlerError({
    status: 409,
    message:
      cause instanceof Error
        ? cause.message
        : "The invoice PDF could not be rendered.",
    hint: "Check the seller payment details and invoice dates before exporting.",
    cause,
  });
};

type InvoiceRenderRejection = Extract<
  TypstRenderOutcome,
  { status: "rejected" }
>;

// Renderer infrastructure failures are retryable; any other rejection names
// invoice data the user must correct.
const invoiceRenderRejection = ({
  reason,
  diagnostics,
}: InvoiceRenderRejection) => {
  const infrastructureFailure = ["timeout", "crashed", "memory"].includes(
    reason,
  );
  return classifyFailure(
    new HandlerError({
      status: infrastructureFailure ? 503 : 409,
      message: infrastructureFailure
        ? "The invoice PDF renderer is temporarily unavailable."
        : diagnostics.join("\n") || `Invoice rendering was rejected: ${reason}`,
      hint: infrastructureFailure
        ? "Try exporting the invoice again later."
        : "Check the seller payment details and invoice dates before exporting.",
      retryable: infrastructureFailure,
    }),
    infrastructureFailure ? "invoice_renderer_failed" : "conflict",
  );
};

// permissions-exempt: rendering a temporary copy needs the same matter read
// permission as the invoice; it does not modify the invoice.
export const createInvoicePdfExport = (
  writeObject = writeS3ObjectWithRetry,
  renderInvoice = renderInvoiceWithTypst,
) =>
  createSafeHandler(
    {
      contract: "patch",
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
      user,
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
      const outcome = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await renderInvoice({
              session: invoiceTypstSession,
              createdAt: new Date(),
              invoice: {
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
              },
            }),
          catch: invoiceRenderError,
        }),
      );
      if (outcome.isErr()) {
        return Result.err(invoiceRenderError(outcome.error));
      }
      if (outcome.value.status === "rejected") {
        return Result.err(invoiceRenderRejection(outcome.value));
      }
      const body = outcome.value.pdf;
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
              readSessionAuthority: ownerSyntheticSessionAuthorityReader,
              tx,
              recordAuditEvent,
              resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
              resourceId: loaded.invoice.id,
              userId: user.id,
              source: { kind: "request", sessionId: session.id },
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
