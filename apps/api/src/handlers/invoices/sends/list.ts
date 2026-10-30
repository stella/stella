import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { member, user as authUser } from "@/api/db/auth-schema";
import { invoiceSends } from "@/api/db/schema";
import type { ContactEmail } from "@/api/db/schema-validators";
import { projectInvoiceSend } from "@/api/handlers/invoices/sends/projection";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { readInvoiceEmailSender } from "@/api/lib/billing/invoice-send-sender";
import {
  paginationCursorSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedInvoiceSendId } from "@/api/lib/safe-id-boundaries";

type InvoiceSendTableRow = typeof invoiceSends.$inferSelect;

const UNPROJECTED_INVOICE_SEND_COLUMNS = [
  // Tenant and invoice scope are established by the authorized route.
  "organizationId",
  "invoiceId",
  // Sender attribution is joined to the current member and projected as a name.
  "sentByUserId",
  // Link credentials and revocation actor are never client data.
  "tokenHash",
  "revokedByUserId",
] as const satisfies readonly (keyof InvoiceSendTableRow)[];

const INVOICE_SEND_SELECTION = {
  id: invoiceSends.id,
  recipients: invoiceSends.recipients,
  failedRecipients: invoiceSends.failedRecipients,
  message: invoiceSends.message,
  replyTo: invoiceSends.replyTo,
  language: invoiceSends.language,
  deliveryStatus: invoiceSends.deliveryStatus,
  expiresAt: invoiceSends.expiresAt,
  revokedAt: invoiceSends.revokedAt,
  firstViewedAt: invoiceSends.firstViewedAt,
  createdAt: invoiceSends.createdAt,
} as const;

type MissingInvoiceSendColumn = UnprojectedColumns<
  InvoiceSendTableRow,
  typeof INVOICE_SEND_SELECTION,
  (typeof UNPROJECTED_INVOICE_SEND_COLUMNS)[number]
>;
type UnexpectedInvoiceSendColumn = UnbackedProjectionKeys<
  InvoiceSendTableRow,
  typeof INVOICE_SEND_SELECTION,
  (typeof UNPROJECTED_INVOICE_SEND_COLUMNS)[number]
>;

true satisfies MissingInvoiceSendColumn extends never ? true : never;
true satisfies UnexpectedInvoiceSendColumn extends never ? true : never;

/** The client's addresses a send starts from: primary first, each once. */
const defaultRecipientsOf = (
  emails: readonly ContactEmail[] | null,
): string[] => {
  if (emails === null) {
    return [];
  }
  const ordered = emails.toSorted((left, right) => {
    if (left.isPrimary === right.isPrimary) {
      return 0;
    }
    return left.isPrimary ? -1 : 1;
  });
  return [
    ...new Set(
      ordered
        .map((email) => email.address.trim())
        .filter((address) => address !== ""),
    ),
  ];
};

const SENDS_PAGE_SIZE_DEFAULT = 20;
const SENDS_PAGE_SIZE_MAX = 100;

const sendHistoryCursor = createTimestampIdCursorCodec({
  column: invoiceSends.createdAt,
  brandId: brandPersistedInvoiceSendId,
});

const config = {
  contract: "patch",
  description:
    "List the emails an invoice was sent with, newest first with cursor pagination: recipients, time, delivery, reply-to, and whether its link is active, expired, revoked or failed, with when it was first opened. defaultRecipients are the client's email addresses, primary first; replyTo is where replies to a new send would go, or null when the reader has no verified sending address. Pass nextCursor as cursor to read older sends.",
  permissions: { invoice: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    reason: "billing_admin",
    consumesServices: false,
    readClass: "tenant",
  },
  params: workspaceParams({ invoiceId: resourceIdSchema("invoice") }),
  query: v.object({
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(SENDS_PAGE_SIZE_MAX),
        ),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const listInvoiceSends = createSafeHandler(
  config,
  async function* ({ safeDb, user, session, workspaceId, params, query }) {
    const limit = normalizeTenantPageLimit(
      query.limit ?? SENDS_PAGE_SIZE_DEFAULT,
    );
    const conditions = [eq(invoiceSends.invoiceId, params.invoiceId)];
    if (query.cursor !== undefined) {
      const cursor = sendHistoryCursor.decode(query.cursor);
      if (cursor === null) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const condition = sendHistoryCursor.keysetAfter({
        cursor,
        idColumn: invoiceSends.id,
        direction: "descending",
      });
      if (condition !== undefined) {
        conditions.push(condition);
      }
    }
    const loaded = yield* Result.await(
      safeDb(async (tx) => {
        const invoice = await tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
            RAW: (table) => invoiceInMatter(table, workspaceId),
          },
          columns: { id: true, clientId: true, sellerProfileId: true },
        });
        if (!invoice) {
          return null;
        }
        const client =
          invoice.clientId === null
            ? undefined
            : await tx.query.contacts.findFirst({
                where: { id: { eq: invoice.clientId } },
                columns: { emails: true },
              });
        const sender = await readInvoiceEmailSender(tx, {
          organizationId: session.activeOrganizationId,
          userId: user.id,
          sellerProfileId: invoice.sellerProfileId,
        });
        const sends = await tx
          .select({
            ...INVOICE_SEND_SELECTION,
            sentById: authUser.id,
            sentByName: authUser.name,
            createdAtCursor:
              sendHistoryCursor.cursorValue.as("created_at_cursor"),
          })
          .from(invoiceSends)
          // A sender is named while still a member of this organization.
          .leftJoin(
            member,
            and(
              eq(member.userId, invoiceSends.sentByUserId),
              eq(member.organizationId, invoiceSends.organizationId),
            ),
          )
          .leftJoin(authUser, eq(authUser.id, member.userId))
          .where(and(...conditions))
          .orderBy(desc(invoiceSends.createdAt), desc(invoiceSends.id))
          .limit(limit + 1);
        return {
          sends,
          clientEmails: client?.emails ?? null,
          sender,
        };
      }),
    );
    if (loaded === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice not found" }),
      );
    }
    const page = createCursorPage({
      rows: loaded.sends,
      limit,
      cursorForItem: (row) =>
        sendHistoryCursor.encode(row.createdAtCursor, row.id),
    });
    const now = new Date();
    return Result.ok({
      defaultRecipients: defaultRecipientsOf(loaded.clientEmails),
      replyTo: loaded.sender.isOk() ? loaded.sender.value.replyTo : null,
      nextCursor: page.nextCursor,
      limit: page.limit,
      items: page.items.map(
        ({ sentById, sentByName, createdAtCursor: _createdAtCursor, ...row }) =>
          projectInvoiceSend(
            {
              ...row,
              sentBy:
                sentById === null || sentByName === null
                  ? null
                  : { id: sentById, name: sentByName },
            },
            now,
          ),
      ),
    });
  },
);

export default listInvoiceSends;
