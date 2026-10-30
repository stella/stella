import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

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
