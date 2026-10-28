import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { RequestContext } from "@/api/http/context";
import type { VerifyCaller } from "@/api/lib/api-handlers";
import { recordAuditGroups } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { resolveInvoiceLink } from "@/api/lib/billing/invoice-links";
import type { InvoiceLinkScope } from "@/api/lib/billing/invoice-links";
import { resolveClientIp } from "@/api/lib/client-ip";
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
 * with its sending member retained as history when available.
 */
const invoiceLinkAuditBindings = (
  caller: InvoiceLinkCaller,
  workspaceId: InvoiceLinkScope["workspaceIds"][number] | null,
) => ({
  organizationId: caller.organizationId,
  workspaceId,
  userId: caller.userId ?? "invoice_link",
  execution: {
    performer: {
      type: "service" as const,
      id: "invoice_link",
      name: "Invoice link",
    },
    trigger: {
      type: "system" as const,
      source: "invoice_link",
      sourceId: caller.sendId,
    },
  },
});

type InvoiceLinkAuditOptions = {
  caller: InvoiceLinkCaller;
  workspaceId: InvoiceLinkScope["workspaceIds"][number] | null;
  context: Pick<RequestContext, "request" | "server">;
};

/** Service provenance survives deletion of the sending account. */
export const createInvoiceLinkAuditRecorder =
  ({ caller, workspaceId, context }: InvoiceLinkAuditOptions) =>
  async (tx: Transaction, event: AuditEvent) => {
    await recordAuditGroups({
      tx,
      groups: [
        {
          bindings: invoiceLinkAuditBindings(caller, workspaceId),
          events: [event],
        },
      ],
      requestMetadata: {
        ipAddress: resolveClientIp(context.request, context.server),
        userAgent: context.request.headers.get("user-agent"),
      },
    });
  };

/** A matter the invoice bills; every document read is scoped through it. */
export const anchorMatter = (caller: InvoiceLinkCaller) =>
  caller.workspaceIds.at(0) ?? panic("A live invoice link bills a matter");
