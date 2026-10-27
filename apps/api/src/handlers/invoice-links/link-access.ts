import { panic, Result } from "better-result";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { invoiceSends } from "@/api/db/schema";
import { loadInvoiceDocument } from "@/api/handlers/invoices/pdf/document";
import type { RequestContext } from "@/api/http/context";
import type { VerifyCaller } from "@/api/lib/api-handlers";
import { resolveInvoiceLink } from "@/api/lib/billing/invoice-links";
import type { InvoiceLinkScope } from "@/api/lib/billing/invoice-links";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { tokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { isRecord } from "@/api/lib/type-guards";

/**
 * What every refusal of an invoice link says: unknown, malformed, revoked,
 * expired and void are one answer, so a link is never probeable.
 */
export const linkUnavailable = () =>
  new HandlerError({
    status: 404,
    code: "invoice_link_unavailable",
    message: "This invoice link is no longer available.",
    hint: "Ask the sender for a new link.",
  });

export type InvoiceLinkCaller = InvoiceLinkScope & {
  db: TokenScopedDatabase;
};

/** The link in the body proves the caller; it is checked before any schema. */
export const verifyInvoiceLinkCaller =
  ({
    db = tokenScopedDatabase,
    isAvailable,
  }: {
    db?: TokenScopedDatabase | undefined;
    isAvailable: () => boolean;
  }): VerifyCaller<InvoiceLinkCaller> =>
  async ({ body }) => {
    // A deployment without the feature answers like a dead link, before any
    // lookup.
    if (!isAvailable()) {
      return Result.err(linkUnavailable());
    }
    const token = isRecord(body) ? body["token"] : undefined;
    const scope = await Result.tryPromise({
      try: async () => await resolveInvoiceLink(db, token),
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to open the invoice link.",
          cause,
        }),
    });
    if (Result.isError(scope)) {
      return Result.err(scope.error);
    }
    return scope.value === null
      ? Result.err(linkUnavailable())
      : Result.ok({ ...scope.value, db });
  };

/**
 * Who an invoice link's audit rows name: the invoice, performed by the link
 * and owned by the member who sent it. Pass to `createAuditRecorder`.
 */
export const invoiceLinkAuditBindings = (
  caller: InvoiceLinkCaller,
  workspaceId: InvoiceLinkScope["workspaceIds"][number] | null,
  { request, server }: Pick<RequestContext, "request" | "server">,
) => ({
  organizationId: caller.organizationId,
  workspaceId,
  userId: caller.userId,
  request,
  server,
  execution: {
    performer: {
      type: "service" as const,
      id: "invoice_link",
      name: "Invoice link",
    },
    trigger: {
      type: "credential" as const,
      ownerUserId: caller.userId,
      source: "invoice_link",
      sourceId: caller.sendId,
    },
  },
});

/** A matter the invoice bills; every document read is scoped through it. */
export const anchorMatter = (caller: InvoiceLinkCaller) =>
  caller.workspaceIds[0] ?? panic("A live invoice link bills a matter");

/**
 * Inside the link's tenant scope: the send, re-read under row security and
 * still live, and the invoice document it delivers. Null refuses the link
 * (the sender lost access, or the send changed since the lookup).
 */
export const loadLinkedDocument = async (
  tx: Transaction,
  caller: InvoiceLinkCaller,
) => {
  const [send] = await tx
    .select({ id: invoiceSends.id, expiresAt: invoiceSends.expiresAt })
    .from(invoiceSends)
    .where(
      and(
        eq(invoiceSends.id, caller.sendId),
        eq(invoiceSends.invoiceId, caller.invoiceId),
        isNull(invoiceSends.revokedAt),
        // The database clock, the same one the lookup judged expiry by.
        gt(invoiceSends.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (!send) {
    return null;
  }
  const document = await loadInvoiceDocument(tx, {
    organizationId: caller.organizationId,
    workspaceId: anchorMatter(caller),
    invoiceId: caller.invoiceId,
  });
  return document === null ? null : { send, document };
};
