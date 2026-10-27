import { userOrganizationPolicies } from "@/api/db/rls";

import { reviewResetOwnerPolicies } from "../review-reset-policies";
import {
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";

export const REQUEST_IDEMPOTENCY_STATES = ["pending", "completed"] as const;

const ownerOnly = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.request_idempotency_receipts'::regclass)`;

/**
 * One receipt per (organization, user, Idempotency-Key). The first create
 * request claims it as pending; a repeat of the same request replays the
 * stored answer once it completes. Owned by `lib/idempotency/request-receipts`.
 */
export const requestIdempotencyReceipts = p.pgTable.withRLS(
  "request_idempotency_receipts",
  {
    id: pUuid<"requestIdempotencyReceipt">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    idempotencyKey: p.varchar("idempotency_key", { length: 128 }).notNull(),
    route: p.varchar("route", { length: 256 }).notNull(),
    requestFingerprint: p
      .varchar("request_fingerprint", { length: 64 })
      .notNull(),
    state: p.text("state", { enum: REQUEST_IDEMPOTENCY_STATES }).notNull(),
    responseCode: p.integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    claimedAt: timestamptz("claimed_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    p
      .uniqueIndex("request_idempotency_receipts_org_user_key_uidx")
      .on(table.organizationId, table.userId, table.idempotencyKey),
    p
      .index("request_idempotency_receipts_state_claimed_at_idx")
      .on(table.state, table.claimedAt),
    p.check(
      "request_idempotency_receipts_key_nonempty_check",
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    p.check(
      "request_idempotency_receipts_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "request_idempotency_receipts_state_check",
      sql`(${table.state} = 'pending' AND ${table.responseCode} IS NULL AND ${table.completedAt} IS NULL)
      OR (${table.state} = 'completed' AND ${table.responseCode} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
    ...userOrganizationPolicies(),
    ...reviewResetOwnerPolicies("request_idempotency_receipts"),
    // Retention reads candidates globally and deletes through user scopes.
    p.pgPolicy("retention_owner_select", {
      for: "select",
      using: ownerOnly,
    }),
    // Discovery locks need UPDATE visibility; actual writes still require a user scope.
    p.pgPolicy("retention_owner_lock", {
      for: "update",
      using: ownerOnly,
      withCheck: sql`false`,
    }),
  ],
);
