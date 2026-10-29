import { Result } from "better-result";
import type { InferOk } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { loadLinkedInvoiceData } from "@/api/handlers/invoice-links/document";
import { buildLinkedEInvoice } from "@/api/handlers/invoice-links/e-invoice";
import {
  anchorMatter,
  createInvoiceLinkAuditRecorder,
  linkUnavailable,
  verifyInvoiceLinkCaller,
} from "@/api/handlers/invoice-links/link-access";
import type { InvoiceLinkCaller } from "@/api/handlers/invoice-links/link-access";
import {
  invoiceDocumentError,
  invoicePdfFileName,
  renderInvoiceDocumentPdf,
} from "@/api/handlers/invoices/pdf/document";
import type { InvoicePdfRenderer } from "@/api/handlers/invoices/pdf/document";
import { renderInvoiceWithTypst } from "@/api/handlers/invoices/pdf/typst/render-typst";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { isInvoiceLinkTokenShape } from "@/api/lib/billing/invoice-links";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const INVOICE_LINK_FILES = ["pdf", "e_invoice"] as const;

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: { type: "audited" },
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.strictObject({
    token: v.pipe(
      v.string(),
      v.maxLength(64),
      v.check(isInvoiceLinkTokenShape),
    ),
    file: v.picklist(INVOICE_LINK_FILES),
  }),
} satisfies TokenHandlerConfig;

const readFailed = (cause: unknown) =>
  new HandlerError({
    status: 500,
    message: "Failed to prepare the invoice file.",
    cause,
  });

type LinkFile = (typeof INVOICE_LINK_FILES)[number];
type DownloadRequest = Parameters<
  typeof createInvoiceLinkAuditRecorder
>[0]["context"];

type PreparedFile = {
  body: Uint8Array;
  contentType: string;
  fileName: string;
};

type LinkScope = Pick<
  InvoiceLinkCaller,
  "db" | "organizationId" | "userId" | "workspaceIds"
>;

const inLinkScope = (caller: LinkScope) =>
  caller.db.scoped({
    organizationId: caller.organizationId,
    userId: null,
    workspaceIds: caller.workspaceIds,
  });

/**
 * What the file is made from, read in one snapshot: the live send, the
 * invoice document and, for the e-invoice, the built file. The PDF is laid
 * out afterwards, outside the transaction.
 */
const loadLinkedFile = async (caller: InvoiceLinkCaller, file: LinkFile) =>
  await inLinkScope(caller)(async (tx) => {
    const linked = await loadLinkedInvoiceData(tx, caller);
    if (linked === null) {
      return null;
    }
    const { document } = linked;
    const unavailable = invoiceDocumentError(document);
    if (unavailable !== null) {
      return Result.err(unavailable);
    }
    if (file === "pdf") {
      return Result.ok({ document, eInvoice: null });
    }
    const eInvoice = await buildLinkedEInvoice(linked);
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
    return Result.ok({ document, eInvoice: eInvoice.value });
  });

type LoadedLinkedFile = NonNullable<Awaited<ReturnType<typeof loadLinkedFile>>>;

const prepareFile = async (
  loaded: InferOk<LoadedLinkedFile>,
  renderInvoice: InvoicePdfRenderer,
): Promise<Result<PreparedFile, HandlerError>> => {
  if (loaded.eInvoice !== null) {
    return Result.ok({
      body: loaded.eInvoice.body,
      contentType: loaded.eInvoice.contentType,
      fileName: loaded.eInvoice.fileName,
    });
  }
  const pdf = await renderInvoiceDocumentPdf(loaded.document, renderInvoice);
  return pdf.map((body) => ({
    body,
    contentType: PDF_MIME_TYPE,
    fileName: invoicePdfFileName(loaded.document.invoice),
  }));
};

type RecordDownloadOptions = {
  caller: InvoiceLinkCaller;
  file: LinkFile;
  fileName: string;
  invoice: {
    id: string;
    workspaceId: InvoiceLinkCaller["workspaceIds"][number] | null;
  };
  request: DownloadRequest;
};

/** Recorded before the bytes leave; downloading opens the invoice too. */
const recordDownload = async ({
  caller,
  file,
  fileName,
  invoice,
  request,
}: RecordDownloadOptions) =>
  await inLinkScope(caller)(async (tx) => {
    await tx.execute(
      sql`SELECT public.invoice_link_mark_viewed(${caller.tokenHash})`,
    );
    const recordAuditEvent = createInvoiceLinkAuditRecorder({
      caller,
      workspaceId: invoice.workspaceId,
      context: request,
    });
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.DOWNLOAD,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: invoice.id,
      workspaceId: invoice.workspaceId ?? anchorMatter(caller),
      metadata: {
        invoiceSendId: caller.sendId,
        via: "invoice_link",
        file,
        fileName,
      },
    });
  });

/** The link opens only while the deployment offers time billing. */
const timeBillingDeployed = () =>
  isDeploymentFeatureEnabled("FEATURE_TIME_BILLING");

/** Streams one file of a linked invoice through the API after the link check. */
export const createDownloadInvoiceLinkFile = ({
  db,
  renderInvoice = renderInvoiceWithTypst,
  isAvailable = timeBillingDeployed,
}: {
  db?: TokenScopedDatabase;
  renderInvoice?: InvoicePdfRenderer;
  isAvailable?: () => boolean;
} = {}) =>
  createSafeTokenHandler(
    config,
    verifyInvoiceLinkCaller({ db, isAvailable }),
    async function* ({ caller, body, request, server }) {
      const loaded = yield* Result.await(
        Result.tryPromise({
          try: async () => await loadLinkedFile(caller, body.file),
          catch: readFailed,
        }),
      );
      if (loaded === null) {
        return Result.err(linkUnavailable());
      }
      const linked = yield* loaded;
      const file = yield* Result.await(prepareFile(linked, renderInvoice));
      const fileName = sanitizeFilename(file.fileName);
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await recordDownload({
              caller,
              file: body.file,
              fileName,
              invoice: linked.document.invoice,
              request: { request, server },
            }),
          catch: readFailed,
        }),
      );
      return Result.ok(
        secureDocumentResponse({
          body: file.body,
          contentType: file.contentType,
          disposition: "attachment",
          fileName,
          contentLength: file.body.byteLength,
        }),
      );
    },
  );

const handler = createDownloadInvoiceLinkFile();
declareAggregateMutation(handler, {
  type: "independent",
  reason:
    "Reads a token-scoped invoice and records access; the first-view timestamp is a conditional idempotent update without changing invoice state.",
});
export default handler;
