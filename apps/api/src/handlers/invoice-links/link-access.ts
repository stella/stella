import { panic, Result } from "better-result";

import { classifyFailure } from "@stll/errors";

import type { VerifyCaller } from "@/api/lib/api-handlers";
import {
  hashInvoiceLinkToken,
  isInvoiceLinkTokenShape,
  resolveInvoiceLink,
} from "@/api/lib/billing/invoice-links";
import type { InvoiceLinkScope } from "@/api/lib/billing/invoice-links";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { admitInvoiceLinkToken } from "@/api/lib/rate-limit/invoice-link-admission";
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
    admitToken = admitInvoiceLinkToken,
  }: {
    db?: TokenScopedDatabase | undefined;
    isAvailable: () => boolean;
    admitToken?: typeof admitInvoiceLinkToken;
  }): VerifyCaller<InvoiceLinkCaller> =>
  async ({ body }) => {
    // A deployment without the feature answers like a dead link, before any
    // lookup.
    if (!isAvailable()) {
      return Result.err(linkUnavailable());
    }
    const token = isRecord(body) ? body["token"] : undefined;
    if (typeof token !== "string" || !isInvoiceLinkTokenShape(token)) {
      return Result.err(linkUnavailable());
    }
    const scope = await Result.tryPromise({
      try: async () => {
        const admitted = await admitToken(hashInvoiceLinkToken(token));
        if (admitted.isErr()) {
          return Result.err(admitted.error);
        }
        const found = await resolveInvoiceLink(db, token);
        return found === null
          ? Result.err(linkUnavailable())
          : Result.ok({ ...found, db });
      },
      catch: (cause) =>
        classifyFailure(
          new HandlerError({
            status: 500,
            message: "Failed to open the invoice link.",
            cause,
          }),
          "invoice_link_read_failed",
        ),
    });
    if (Result.isError(scope)) {
      return Result.err(scope.error);
    }
    return scope.value;
  };

/**
 * Who an invoice link's audit rows name: the invoice, performed by the link
 * with its sending member retained as history when available.
 */
export const invoiceLinkAuditBindings = (
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

/** A matter the invoice bills; every document read is scoped through it. */
export const anchorMatter = (caller: InvoiceLinkCaller) =>
  caller.workspaceIds.at(0) ?? panic("A live invoice link bills a matter");
