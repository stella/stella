import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

import { timestamptz } from "../columns";

const TABLE_LEASE_HOLDER_KINDS = ["job", "migration"] as const;
const TABLE_LEASE_MODES = ["shared", "exclusive"] as const;

export const schedulerTableLeases = pgTable.withRLS(
  "scheduler_table_leases",
  {
    tableName: text("table_name").notNull(),
    holderKind: text("holder_kind", {
      enum: TABLE_LEASE_HOLDER_KINDS,
    }).notNull(),
    holderId: text("holder_id").notNull(),
    mode: text("mode", { enum: TABLE_LEASE_MODES }).notNull(),
    requestedAt: timestamptz("requested_at")
      .default(sql`clock_timestamp()`)
      .notNull(),
    grantedAt: timestamptz("granted_at"),
    expiresAt: timestamptz("expires_at").notNull(),
  },
  (table) => [
    pgPolicy("scheduler_table_leases_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_leases'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_leases'::regclass)`,
    }),
    primaryKey({
      columns: [table.tableName, table.holderKind, table.holderId],
    }),
    index("scheduler_table_leases_queue_idx").on(
      table.tableName,
      table.requestedAt,
      table.holderId,
      table.expiresAt,
    ),
    index("scheduler_table_leases_holder_idx").on(table.holderId),
    check(
      "scheduler_table_leases_holder_kind_check",
      sql`${table.holderKind} IN (${sql.join(
        TABLE_LEASE_HOLDER_KINDS.map((kind) => sql.raw(`'${kind}'`)),
        sql`, `,
      )})`,
    ),
    check(
      "scheduler_table_leases_mode_check",
      sql`${table.mode} IN (${sql.join(
        TABLE_LEASE_MODES.map((mode) => sql.raw(`'${mode}'`)),
        sql`, `,
      )})`,
    ),
    check(
      "scheduler_table_lease_kind_mode",
      sql`(${table.holderKind} = 'job' AND ${table.mode} = 'shared' AND ${table.grantedAt} IS NOT NULL) OR (${table.holderKind} = 'migration' AND ${table.mode} = 'exclusive')`,
    ),
  ],
);

/** Durable evidence of successful lease-aware scheduler admission. */
export const schedulerTableLeaseActivity = pgTable.withRLS(
  "scheduler_table_lease_activity",
  {
    slot: integer("slot").primaryKey().default(0),
    lastClaimedAt: timestamptz("last_claimed_at").notNull(),
  },
  (table) => [
    pgPolicy("scheduler_table_lease_activity_owner_access", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_lease_activity'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.scheduler_table_lease_activity'::regclass)`,
    }),
    check("scheduler_table_lease_activity_singleton", sql`${table.slot} = 0`),
  ],
);
