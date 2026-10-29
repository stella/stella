import { Result } from "better-result";
import * as v from "valibot";

import { deliverInvoiceLink } from "@/api/handlers/invoice-links/delivery";
import { buildLinkedEInvoice } from "@/api/handlers/invoice-links/e-invoice";
import {
  INVOICE_LINK_FILES,
  prepareLinkedInvoiceFile,
} from "@/api/handlers/invoice-links/file-preparation";
import {
  linkUnavailable,
  verifyInvoiceLinkCaller,
} from "@/api/handlers/invoice-links/link-access";
import type { InvoicePdfRenderer } from "@/api/handlers/invoices/pdf/document";
import { renderInvoiceWithTypst } from "@/api/handlers/invoices/pdf/typst/render-typst";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import type { TokenHandlerConfig } from "@/api/lib/api-handlers";
import { isInvoiceLinkTokenShape } from "@/api/lib/billing/invoice-links";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";

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

/** The link opens only while the deployment offers time billing. */
const timeBillingDeployed = () =>
  isDeploymentFeatureEnabled("FEATURE_TIME_BILLING");

/** Streams one file of a linked invoice through the API after the link check. */
export const createDownloadInvoiceLinkFile = ({
  db,
  renderInvoice = renderInvoiceWithTypst,
  buildEInvoice = buildLinkedEInvoice,
  isAvailable = timeBillingDeployed,
}: {
  db?: TokenScopedDatabase;
  renderInvoice?: InvoicePdfRenderer;
  buildEInvoice?: typeof buildLinkedEInvoice;
  isAvailable?: () => boolean;
} = {}) =>
  createSafeTokenHandler(
    config,
    verifyInvoiceLinkCaller({ db, isAvailable }),
    async function* ({ caller, body, request, server }) {
      const loaded = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await prepareLinkedInvoiceFile({
              caller,
              file: body.file,
              buildEInvoice,
              renderInvoice,
            }),
          catch: readFailed,
        }),
      );
      if (loaded === null) {
        return Result.err(linkUnavailable());
      }
      const file = yield* loaded;
      const fileName = sanitizeFilename(file.fileName);
      return yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await deliverInvoiceLink({
              caller,
              workspaceId: file.workspaceId,
              delivery: { type: "download", file: body.file, fileName },
              context: { request, server },
              response: () =>
                secureDocumentResponse({
                  body: file.body,
                  contentType: file.contentType,
                  disposition: "attachment",
                  fileName,
                  contentLength: file.body.byteLength,
                }),
            }),
          catch: readFailed,
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
