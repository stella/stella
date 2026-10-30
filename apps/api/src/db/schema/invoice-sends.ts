import { INVOICE_LANGUAGES, INVOICE_SEND_LIMITS } from "@stll/api-contract";

import {
  completeInvoiceVisibilityPolicy,
  organizationCheck,
} from "@/api/db/rls";

import { invoices } from "./billing";
import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  sql,
  stella,
  timestamptz,
  user,
} from "./common";

/**
 * How a send's emails left: `pending` while they go out, then `delivered` to
 * every recipient, `partial` when some failed, `failed` when none left (the
 * link is then revoked with the send).
 */
const INVOICE_SEND_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "partial",
  "failed",
] as const;
export type InvoiceSendDeliveryStatus =
  (typeof INVOICE_SEND_DELIVERY_STATUSES)[number];

const INVOICE_SEND_DELIVERY_STATUS_SQL_VALUES =
  INVOICE_SEND_DELIVERY_STATUSES.map((status) => sql.raw(`'${status}'`));

const currentUserOwnsInvoiceSends = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.invoice_sends'::regclass)`;

/**
 * One delivery of an issued invoice by email: who sent it to whom, and the
 * link the email carried. The link is a bearer token; only its SHA-256 is
 * stored. A send never changes the invoice it delivers, and every re-send is
 * a new row, so the rows are the invoice's delivery history.
 *
 * Rows are visible only together with their invoice (the restrictive policy
 * reads `invoices` under its own row security), and they leave with it.
 * The table owner reads them only through `invoice_link_scope`, the lookup
 * that resolves a link's token to its tenant.
 */
export const invoiceSends = p.pgTable(
  "invoice_sends",
  {
    id: pUuid<"invoiceSend">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The tenant key is installed after migrations; row security checks the invoice organization.
    invoiceId: safeUuid<"invoice">("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    // Historical attribution; links remain valid after the sender is deleted.
    sentByUserId: p
      .text("sent_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    recipients: p.text().array().notNull(),
    // The recipients whose email the provider refused.
    failedRecipients: p
      .text("failed_recipients")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    message: p.text(),
    language: p.text({ enum: INVOICE_LANGUAGES }).notNull(),
    replyTo: p.varchar("reply_to", { length: 320 }).notNull(),
    tokenHash: p.varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at")
      .notNull()
      .default(sql`(now() + '60 days'::interval)`),
    deliveryStatus: p
      .text("delivery_status", { enum: INVOICE_SEND_DELIVERY_STATUSES })
      .notNull()
      .default("pending"),
    revokedAt: timestamptz("revoked_at"),
    // Immutable revocation attribution survives account and membership removal.
    revokedByUserId: p.text("revoked_by_user_id"),
    firstViewedAt: timestamptz("first_viewed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => {
    const ownerViewedCheck = sql`${currentUserOwnsInvoiceSends} AND ${table.tokenHash} = NULLIF(pg_catalog.current_setting('app.invoice_link_hash', true), '')`;
    return [
      p.uniqueIndex("invoice_sends_token_hash_uidx").on(table.tokenHash),
      p
        .index("invoice_sends_invoice_created_idx")
        .on(table.invoiceId, table.createdAt, table.id),
      p
        .index("invoice_sends_org_created_idx")
        .on(table.organizationId, table.createdAt),
      p
        .index("invoice_sends_sent_by_idx")
        .on(table.sentByUserId)
        .where(sql`${table.sentByUserId} IS NOT NULL`),
      p
        .index("invoice_sends_revoked_by_idx")
        .on(table.revokedByUserId)
        .where(sql`${table.revokedByUserId} IS NOT NULL`),
      p.check(
        "invoice_sends_delivery_status_check",
        sql`${table.deliveryStatus} in (${sql.join(INVOICE_SEND_DELIVERY_STATUS_SQL_VALUES, sql`, `)})`,
      ),
      p.check(
        "invoice_sends_language_check",
        sql`${table.language} IN (${sql.join(
          INVOICE_LANGUAGES.map((value) => sql`${value}`),
          sql`, `,
        )})`,
      ),
      p.check(
        "invoice_sends_recipients_check",
        sql`cardinality(${table.recipients}) BETWEEN ${sql.raw(String(INVOICE_SEND_LIMITS.minRecipients))} AND ${sql.raw(String(INVOICE_SEND_LIMITS.maxRecipients))} AND ${table.failedRecipients} <@ ${table.recipients}`,
      ),
      p.check(
        "invoice_sends_message_check",
        sql`${table.message} IS NULL OR length(${table.message}) BETWEEN 1 AND ${sql.raw(String(INVOICE_SEND_LIMITS.messageMaxChars))}`,
      ),
      p.check(
        "invoice_sends_revoked_check",
        sql`${table.revokedByUserId} IS NULL OR ${table.revokedAt} IS NOT NULL`,
      ),
      p.pgPolicy("invoice_sends_organization_select", {
        for: "select",
        to: stella,
        using: organizationCheck,
      }),
      p.pgPolicy("invoice_sends_organization_insert", {
        for: "insert",
        to: stella,
        withCheck: organizationCheck,
      }),
      p.pgPolicy("invoice_sends_organization_update", {
        for: "update",
        to: stella,
        using: organizationCheck,
        withCheck: organizationCheck,
      }),
      completeInvoiceVisibilityPolicy("invoice_sends", table),
      p.pgPolicy("invoice_sends_owner_select", {
        for: "select",
        to: "public",
        using: currentUserOwnsInvoiceSends,
      }),
      p.pgPolicy("invoice_sends_owner_viewed", {
        for: "update",
        to: "public",
        using: ownerViewedCheck,
        withCheck: ownerViewedCheck,
      }),
    ];
  },
);

/** Request writers complete delivery or revoke; the token gate alone stamps access. */
export const INVOICE_SEND_UPDATE_COLUMNS = [
  invoiceSends.deliveryStatus,
  invoiceSends.failedRecipients,
  invoiceSends.revokedAt,
  invoiceSends.revokedByUserId,
] as const;
