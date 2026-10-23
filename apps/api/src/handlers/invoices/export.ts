import { Result } from "better-result";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { ownerSyntheticSessionAuthorityReader } from "@/api/db/root";
import {
  buildInvoiceExportFile,
  INVOICE_EXPORT_FORMATS,
} from "@/api/handlers/invoices/export-file";
import {
  loadInvoiceExport,
  MAX_EXPORT_INVOICES,
  toExportRecords,
} from "@/api/handlers/invoices/export-records";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { extractLangFromRequest } from "@/api/lib/locale";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { callerDownloadSource } from "@/api/lib/s3-presign";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

const EXPORT_URL_TTL_SECONDS = 300;

const exportInvoicesBody = v.object({
  format: v.pipe(
    v.picklist(INVOICE_EXPORT_FORMATS),
    v.description(
      "xlsx: one row per invoice; xlsx_lines: one row per invoice line; pohoda, money_s3, flexibee: accounting import XML; isdoc: ISDOC 6.0.2; ubl: UBL 2.1 e-invoices per EN 16931; ksef_fa3: Polish KSeF FA(3) e-invoices (isdoc, ubl and ksef_fa3 are a zip for several invoices); eso9: ESO9 import sheet; ledes_1998b: LEDES 1998B e-billing file",
    ),
  ),
  invoiceIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("invoice")),
      v.minLength(1),
      v.maxLength(MAX_EXPORT_INVOICES),
      v.description(
        "Issued invoices to export; omit to export every issued invoice in the matter",
      ),
    ),
  ),
});

// permissions-exempt: the export is a temporary copy of issued invoices the
// caller can already read in this matter; nothing in the matter changes.
export const createInvoicesExport = (writeObject = writeS3ObjectWithRetry) =>
  createSafeHandler(
    {
      contract: "patch",
      contentDelivery: { type: "audited" },
      description:
        "Export a matter's issued invoices, advance invoices and credit notes (drafts and void invoices excluded) as a spreadsheet, an accounting import file (POHODA, Money S3, ABRA Flexi, ESO9), ISDOC, UBL (EN 16931) or Polish KSeF FA(3) e-invoices, or a LEDES 1998B e-billing file. Pass invoiceIds to export a selection; one export holds at most 500 invoices. Refused when a format cannot hold the data, e.g. Money S3 or ISDOC for an invoice outside the seller's home currency, or KSeF FA(3) for a credit note. Returns a short-lived downloadUrl, fileName and expiresAt; hand the URL to the user without reading the file bytes.",
      permissions: { workspace: ["read"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      featureAccess: { featureId: "time-billing", type: "required" },
      access: "write",
      mcp: {
        type: "capability",
        reason: "billing_admin",
        consumesServices: false,
      },
      params: workspaceParams({}),
      body: exportInvoicesBody,
      realtime: noResourceSetUpdates(
        "Stores a generated export download; nothing a web view lists changes.",
      ),
    },
    async function* ({
      safeDb,
      workspaceId,
      session,
      body,
      user,
      request,
      recordAuditEvent,
    }) {
      const organizationId = session.activeOrganizationId;
      const loaded = yield* Result.await(
        safeDb(
          async (tx) =>
            await loadInvoiceExport(tx, {
              organizationId,
              workspaceId,
              invoiceIds: body.invoiceIds,
            }),
        ),
      );
      const records = yield* toExportRecords(loaded, body.invoiceIds);
      const file = yield* Result.await(
        buildInvoiceExportFile({
          format: body.format,
          records,
          lang: extractLangFromRequest(request) === "cs" ? "cs" : "en",
          packageId: `stella-${Bun.randomUUIDv7()}`,
        }).then((built) =>
          built.mapError(
            (error) =>
              new HandlerError({
                status: 409,
                message: error.message,
                hint: "Choose another format, or export the invoices this format cannot hold separately.",
              }),
          ),
        ),
      );

      // A matter-wide export stays one even when it holds a single invoice.
      const single =
        body.invoiceIds?.length === 1 && records.length === 1
          ? records[0]
          : undefined;
      const stem = single
        ? `invoice-${single.number}`
        : `invoices-${records[0]?.matter.reference ?? workspaceId}`;
      const fileName = sanitizeFilenamePreservingExtension(
        `${stem}-${body.format.replaceAll("_", "-")}.${file.extension}`,
      );
      const key = `exports/${organizationId}/${workspaceId}/invoices/${Bun.randomUUIDv7()}.${file.extension}`;
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await writeObject(
              { contentType: file.contentType, data: file.body, key },
              { type: "lifecycle-prefix", prefix: "exports/" },
            ),
          catch: (cause) =>
            new HandlerError({
              status: 502,
              message: "The invoice export could not be stored.",
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
              resourceType: single
                ? AUDIT_RESOURCE_TYPE.INVOICE
                : AUDIT_RESOURCE_TYPE.WORKSPACE,
              resourceId: single ? single.id : workspaceId,
              userId: user.id,
              source: callerDownloadSource(session),
              s3Key: key,
              s3Keyspace: "exports",
              expiresInSeconds: EXPORT_URL_TTL_SECONDS,
              fileName,
              organizationId,
              workspaceId,
              metadata: { format: body.format, invoiceCount: records.length },
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

const exportInvoices = createInvoicesExport();

declareAggregateMutation(exportInvoices, {
  type: "independent",
  reason:
    "Reads issued invoices and writes only a temporary export object and its download audit event; no matter or invoice row changes.",
});

export default exportInvoices;
