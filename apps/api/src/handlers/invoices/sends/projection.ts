import type { invoiceSends } from "@/api/db/schema";

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

/**
 * Whether the link a send carried still opens: `active`, or why not. A send
 * whose emails all failed never had a working link.
 */
const invoiceSendLinkStatus = (row: InvoiceSendRow, now: Date) => {
  if (row.deliveryStatus === "failed") {
    return "failed" as const;
  }
  if (row.revokedAt !== null) {
    return "revoked" as const;
  }
  if (row.expiresAt <= now) {
    return "expired" as const;
  }
  return "active" as const;
};

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
