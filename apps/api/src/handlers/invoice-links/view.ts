import { Result } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { INVOICE_STATUS } from "@/api/db/schema";
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
  invoiceDocumentRenderOptions,
  invoicePdfFileName,
} from "@/api/handlers/invoices/pdf/document";
import { buildInvoiceTemplateData } from "@/api/handlers/invoices/pdf/typst/data";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { isInvoiceLinkTokenShape } from "@/api/lib/billing/invoice-links";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  contentDelivery: {
    type: "none",
    reason:
      "Returns the invoice summary its link holder may read; files leave through the audited download route.",
  },
  mcp: { type: "internal", reason: "session_token_exchange" },
  body: v.strictObject({
    token: v.pipe(
      v.string(),
      v.maxLength(64),
      v.check(isInvoiceLinkTokenShape),
    ),
  }),
} satisfies TokenHandlerConfig;

const readFailed = (cause: unknown) =>
  new HandlerError({
    status: 500,
    message: "Failed to open the invoice.",
    cause,
  });

/**
 * Opens an invoice from its link: the summary a recipient needs to pay it
 * and the files on offer. The first open stamps the send as viewed; every
 * open is audited on the invoice.
 */
/** The link opens only while the deployment offers time billing. */
const timeBillingDeployed = () =>
  isDeploymentFeatureEnabled("FEATURE_TIME_BILLING");

export const createViewInvoiceLink = ({
  db,
  isAvailable = timeBillingDeployed,
}: {
  db?: TokenScopedDatabase;
  isAvailable?: () => boolean;
} = {}) =>
  createSafeTokenHandler(
    config,
    verifyInvoiceLinkCaller({ db, isAvailable }),
    async function* ({ caller, request, server }) {
      const opened = yield* Result.await(
        Result.tryPromise({
          try: async () => await openLinkedInvoice(caller, { request, server }),
          catch: readFailed,
        }),
      );
      if (opened === null) {
        return Result.err(linkUnavailable());
      }
      return opened;
    },
  );

type OpenRequest = Parameters<
  typeof createInvoiceLinkAuditRecorder
>[0]["context"];

const openLinkedInvoice = async (
  caller: InvoiceLinkCaller,
  request: OpenRequest,
) =>
  await caller.db.scoped({
    organizationId: caller.organizationId,
    userId: null,
    workspaceIds: caller.workspaceIds,
  })(async (tx) => {
    const linked = await loadLinkedInvoiceData(tx, caller);
    if (linked === null) {
      return null;
    }
    const { document } = linked;
    const unavailable = invoiceDocumentError(document);
    if (unavailable !== null) {
      return Result.err(unavailable);
    }
    const data = buildInvoiceTemplateData(
      invoiceDocumentRenderOptions(document),
    );
    if (data.isErr()) {
      return Result.err(
        new HandlerError({ status: 409, message: data.error.message }),
      );
    }
    const eInvoice = await buildLinkedEInvoice(linked);
    await tx.execute(
      sql`SELECT public.invoice_link_mark_viewed(${caller.tokenHash})`,
    );
    const recordAuditEvent = createInvoiceLinkAuditRecorder({
      caller,
      workspaceId: document.invoice.workspaceId,
      context: request,
    });
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.ACCESS,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: document.invoice.id,
      workspaceId: document.invoice.workspaceId ?? anchorMatter(caller),
      metadata: { invoiceSendId: caller.sendId, via: "invoice_link" },
    });
    const { invoice } = document;
    const paid = invoice.status === INVOICE_STATUS.PAID;
    const payable =
      paid || invoice.documentType === "credit_note"
        ? null
        : data.value.payment;
    return Result.ok({
      language: invoice.language,
      dir: data.value.dir,
      documentType: invoice.documentType,
      title: data.value.title,
      paid,
      seller: data.value.seller?.name ?? null,
      buyer: data.value.buyer.name,
      meta: data.value.meta,
      // Net, VAT and the total, each with its label in the invoice language.
      totals: [
        { label: data.value.labels.net, value: data.value.totals.net },
        { label: data.value.labels.vat, value: data.value.totals.vat },
        { label: data.value.labels.total, value: data.value.totals.gross },
      ],
      payment: payable
        ? {
            label: data.value.labels.payment,
            fields: payable.fields,
            accountNumber: payable.accountNumber,
            qrSvg: payable.qrSvg,
          }
        : null,
      files: {
        pdf: { fileName: invoicePdfFileName(invoice) },
        eInvoice:
          eInvoice.isOk() && eInvoice.value !== null
            ? {
                format: eInvoice.value.format,
                fileName: eInvoice.value.fileName,
              }
            : null,
      },
      expiresAt: linked.send.expiresAt.toISOString(),
    });
  });

const handler = createViewInvoiceLink();
declareAggregateMutation(handler, {
  type: "independent",
  reason:
    "Reads a token-scoped invoice and records access; the first-view timestamp is a conditional idempotent update without changing invoice state.",
});
export default handler;
