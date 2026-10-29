import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { ownerSyntheticSessionAuthorityReader } from "@/api/lib/auth";
import {
  invoiceDocumentError,
  invoicePdfFileName,
  loadInvoiceDocument,
  renderInvoiceDocumentPdf,
} from "@/api/lib/billing/invoice-pdf/document";
import type { InvoicePdfRenderer } from "@/api/lib/billing/invoice-pdf/document";
import { renderInvoiceWithTypst } from "@/api/lib/billing/invoice-pdf/typst/render-typst";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { callerDownloadSource } from "@/api/lib/s3-presign";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const EXPORT_URL_TTL_SECONDS = 300;

const config = {
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
  params: workspaceParams({ invoiceId: resourceIdSchema("invoice") }),
  realtime: noResourceSetUpdates(
    "Stores a generated PDF download; nothing a web view lists changes.",
  ),
} satisfies WorkspaceHandlerConfig;

// permissions-exempt: rendering a temporary copy needs the same matter read
// permission as the invoice; it does not modify the invoice.
export const createInvoicePdfExport = (
  writeObject = writeS3ObjectWithRetry,
  renderInvoice: InvoicePdfRenderer = renderInvoiceWithTypst,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      workspaceId,
      session,
      params,
      user,
      recordAuditEvent,
    }) {
      const loaded = yield* Result.await(
        safeDb(
          async (tx) =>
            await loadInvoiceDocument(tx, {
              organizationId: session.activeOrganizationId,
              workspaceId,
              invoiceId: params.invoiceId,
            }),
        ),
      );
      if (!loaded) {
        return Result.err(
          new HandlerError({ status: 404, message: "Invoice not found" }),
        );
      }
      const unavailable = invoiceDocumentError(loaded);
      if (unavailable !== null) {
        return Result.err(unavailable);
      }
      const body = yield* Result.await(
        renderInvoiceDocumentPdf(loaded, renderInvoice),
      );
      const fileName = invoicePdfFileName(loaded.invoice);
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
              code: "internal_error",
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
              source: callerDownloadSource(session),
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
