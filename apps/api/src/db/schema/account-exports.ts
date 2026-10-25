import { sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

import { user } from "@/api/db/auth-schema";
import { jsonb, timestamptz } from "@/api/db/columns";
import { stella } from "@/api/db/rls";
import {
  ACCOUNT_EXPORT_ACTIVE_STATUSES,
  ACCOUNT_EXPORT_IDLE_STATUSES,
  ACCOUNT_EXPORT_LIMITS,
  ACCOUNT_EXPORT_STATUSES,
} from "@/api/lib/account-export/constants";
import type { SafeId } from "@/api/lib/branded-types";

/** Durable account-owned export work; object keys are reclaimed on expiration or erasure. */
export const accountExports = p.pgTable.withRLS(
  "account_exports",
  {
    id: p.uuid().primaryKey(),
    userId: p
      .text("user_id")
      .$type<SafeId<"user">>()
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: p
      .text({ enum: ACCOUNT_EXPORT_STATUSES })
      .notNull()
      .default("requested"),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    claimToken: p.uuid("claim_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    objectKey: p.text("object_key"),
    attemptObjectKeys: jsonb("attempt_object_keys")
      .$type<string[]>()
      .notNull()
      .default([]),
    expiresAt: timestamptz("expires_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "account_exports_status_check",
      sql`${table.status} IN (${sql.join(
        ACCOUNT_EXPORT_STATUSES.map((status) => sql`${status}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "account_exports_state_check",
      sql`(
    (${table.status} = 'processing' AND ${table.claimToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.objectKey} IS NOT NULL AND ${table.expiresAt} IS NULL)
    OR (${table.status} = 'ready' AND ${table.claimToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.objectKey} IS NOT NULL AND ${table.expiresAt} IS NOT NULL)
    OR (${table.status} IN (${sql.join(
      ACCOUNT_EXPORT_IDLE_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    )}) AND ${table.claimToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.objectKey} IS NULL AND ${table.expiresAt} IS NULL)
  )`,
    ),
    p.check(
      "account_exports_attempt_check",
      sql`${table.attemptCount} BETWEEN 0 AND ${ACCOUNT_EXPORT_LIMITS.attempts} AND jsonb_array_length(${table.attemptObjectKeys}) <= ${ACCOUNT_EXPORT_LIMITS.attempts}`,
    ),
    p
      .uniqueIndex("account_exports_user_active_idx")
      .on(table.userId)
      .where(
        sql`${table.status} IN (${sql.join(
          ACCOUNT_EXPORT_ACTIVE_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})`,
      ),
    p
      .index("account_exports_user_created_idx")
      .on(table.userId, table.createdAt, table.id),
    p.index("account_exports_recovery_idx").on(table.status, table.id),
    p.pgPolicy("account_exports_select", {
      for: "select",
      to: stella,
      using: sql`${table.userId} = (SELECT current_setting('app.user_id', true))`,
    }),
    p.pgPolicy("account_exports_insert", {
      for: "insert",
      to: stella,
      withCheck: sql`${table.userId} = (SELECT current_setting('app.user_id', true))`,
    }),
    p.pgPolicy("account_exports_update", {
      for: "update",
      to: stella,
      using: sql`${table.userId} = (SELECT current_setting('app.user_id', true))`,
      withCheck: sql`${table.userId} = (SELECT current_setting('app.user_id', true))`,
    }),
    p.pgPolicy("account_exports_owner", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.account_exports'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.account_exports'::regclass)`,
    }),
  ],
);
