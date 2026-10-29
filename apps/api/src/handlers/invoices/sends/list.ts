import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import { member, user as authUser } from "@/api/db/auth-schema";
import { invoiceSends } from "@/api/db/schema";
import type { ContactEmail } from "@/api/db/schema-validators";
import { projectInvoiceSend } from "@/api/handlers/invoices/sends/projection";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

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
  const ordered = emails.toSorted(
    (left, right) => Number(right.isPrimary) - Number(left.isPrimary),
  );
  return [
    ...new Set(
      ordered
        .map((email) => email.address.trim())
        .filter((address) => address !== ""),
    ),
  ];
};

/** More sends than the per-invoice limit allows in a long while. */
const MAX_LISTED_SENDS = 100;

const config = {
  contract: "patch",
  description:
    "List the emails an invoice was sent with, newest first: recipients, time, delivery, reply-to, and whether its link is active, expired, revoked or failed, with when it was first opened. defaultRecipients are the client's email addresses, primary first; replyTo is where replies to a new send would go.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  access: "read",
  mcp: {
    type: "capability",
    reason: "billing_admin",
    consumesServices: false,
    readClass: "tenant",
  },
  params: workspaceParams({ invoiceId: resourceIdSchema("invoice") }),
} satisfies WorkspaceHandlerConfig;

const listInvoiceSends = createSafeHandler(
  config,
  async function* ({ safeDb, user, workspaceId, params }) {
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
        const seller =
          invoice.sellerProfileId === null
            ? undefined
            : await tx.query.sellerProfiles.findFirst({
                where: { id: { eq: invoice.sellerProfileId } },
                columns: { email: true },
              });
        const sends = await readBounded(
          tx
            .select({
              ...INVOICE_SEND_SELECTION,
              sentById: authUser.id,
              sentByName: authUser.name,
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
            .where(eq(invoiceSends.invoiceId, invoice.id))
            .orderBy(desc(invoiceSends.createdAt), desc(invoiceSends.id)),
          MAX_LISTED_SENDS,
        );
        return {
          sends,
          clientEmails: client?.emails ?? null,
          sellerEmail: seller?.email ?? null,
        };
      }),
    );
    if (loaded === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice not found" }),
      );
    }
    if (loaded.sends.type === "overflow") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Invoice send history exceeds the read limit",
        }),
      );
    }
    const now = new Date();
    return Result.ok({
      defaultRecipients: defaultRecipientsOf(loaded.clientEmails),
      replyTo: loaded.sellerEmail ?? user.email,
      sends: loaded.sends.rows.map(({ sentById, sentByName, ...row }) =>
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
