import type { InvoiceSendDeliveryStatus, invoiceSends } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type InvoiceSendRow = Pick<
  typeof invoiceSends.$inferSelect,
  | "id"
  | "recipients"
  | "failedRecipients"
  | "message"
  | "replyTo"
  | "language"
  | "deliveryStatus"
  | "expiresAt"
  | "revokedAt"
  | "firstViewedAt"
  | "createdAt"
>;

type InvoiceSendLinkStatus =
  "pending" | "active" | "failed" | "revoked" | "expired";
type LinkRevocation = "unrevoked" | "revoked";
type LinkExpiry = "unexpired" | "expired";

const INVOICE_SEND_LINK_STATUS = {
  pending: {
    unrevoked: { unexpired: "pending", expired: "expired" },
    revoked: { unexpired: "revoked", expired: "revoked" },
  },
  delivered: {
    unrevoked: { unexpired: "active", expired: "expired" },
    revoked: { unexpired: "revoked", expired: "revoked" },
  },
  partial: {
    unrevoked: { unexpired: "active", expired: "expired" },
    revoked: { unexpired: "revoked", expired: "revoked" },
  },
  failed: {
    unrevoked: { unexpired: "failed", expired: "failed" },
    revoked: { unexpired: "failed", expired: "failed" },
  },
} as const satisfies Record<
  InvoiceSendDeliveryStatus,
  Record<LinkRevocation, Record<LinkExpiry, InvoiceSendLinkStatus>>
>;

/** Failed transport, withdrawal and expiry all prevent a pending link becoming active. */
const invoiceSendLinkStatus = (row: InvoiceSendRow, now: Date) =>
  INVOICE_SEND_LINK_STATUS[row.deliveryStatus][
    row.revokedAt === null ? "unrevoked" : "revoked"
  ][row.expiresAt <= now ? "expired" : "unexpired"];

/** One send as the firm sees it in the invoice's delivery history. */
export const projectInvoiceSend = (
  row: InvoiceSendRow & { sentBy: { id: string; name: string } | null },
  now: Date,
) => ({
  id: row.id,
  recipients: row.recipients,
  failedRecipients: row.failedRecipients,
  message: row.message,
  replyTo: row.replyTo,
  language: row.language,
  deliveryStatus: row.deliveryStatus,
  linkStatus: invoiceSendLinkStatus(row, now),
  sentBy: row.sentBy,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
  firstViewedAt: row.firstViewedAt?.toISOString() ?? null,
});

type InvoiceSendTableRow = typeof invoiceSends.$inferSelect;
type InvoiceSendOutput = ReturnType<typeof projectInvoiceSend>;
type InvoiceSendDirectProjection = Omit<
  InvoiceSendOutput,
  "linkStatus" | "sentBy"
>;

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

type MissingInvoiceSendProjectionColumn = UnprojectedColumns<
  InvoiceSendTableRow,
  InvoiceSendDirectProjection,
  (typeof UNPROJECTED_INVOICE_SEND_COLUMNS)[number]
>;
type UnexpectedInvoiceSendProjectionColumn = UnbackedProjectionKeys<
  InvoiceSendTableRow,
  InvoiceSendDirectProjection,
  (typeof UNPROJECTED_INVOICE_SEND_COLUMNS)[number]
>;

true satisfies MissingInvoiceSendProjectionColumn extends never ? true : never;
true satisfies UnexpectedInvoiceSendProjectionColumn extends never
  ? true
  : never;
