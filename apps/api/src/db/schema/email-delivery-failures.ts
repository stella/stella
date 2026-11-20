import { EMAIL_DELIVERY_FAILURE_REASONS } from "@stll/api-contract/email-delivery";

import { denyStellaAccessPolicies } from "@/api/db/rls";

import { p, sql, timestamptz } from "./common";

const EMAIL_DELIVERY_FAILURE_REASON_SQL_VALUES =
  EMAIL_DELIVERY_FAILURE_REASONS.map((reason) => sql.raw(`'${reason}'`));

const ownerAccess = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.email_delivery_failures'::regclass)`;

/**
 * The latest failure the mail provider reported for an address, whether or
 * not an account uses it, so the sign-in screen can say why a code does not
 * arrive. A transient failure never stops a send; a later failure replaces
 * the row, and rows expire after `EMAIL_DELIVERY_FAILURE_RETENTION_DAYS`.
 * Keyed by the address only: no provider diagnostic text is kept.
 */
export const emailDeliveryFailures = p.pgTable.withRLS(
  "email_delivery_failures",
  {
    /** The address mail failed to reach, folded by `normalizeEmail`. */
    address: p.text("address").primaryKey(),
    /** Why the provider could not deliver, classified from its bounce. */
    reason: p
      .text("reason", { enum: EMAIL_DELIVERY_FAILURE_REASONS })
      .notNull(),
    /** When the provider reported the failure. */
    failedAt: timestamptz("failed_at").notNull(),
  },
  (table) => [
    p.index("email_delivery_failures_failed_at_idx").on(table.failedAt),
    p.check(
      "email_delivery_failures_reason_domain",
      sql`reason IN (${sql.join(EMAIL_DELIVERY_FAILURE_REASON_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "email_delivery_failures_address_length",
      sql`char_length(address) BETWEEN 3 AND 320`,
    ),
    p.pgPolicy("email_delivery_failures_owner_access", {
      for: "all",
      to: "public",
      using: ownerAccess,
      withCheck: ownerAccess,
    }),
    ...denyStellaAccessPolicies(),
  ],
);
