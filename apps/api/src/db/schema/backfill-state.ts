import type { BatchState } from "@stll/db-load-gate/health";

import { jsonb, p, sql, timestamptz } from "./common";

/** System maintenance state; only the table owner may access checkpoints. */
export const databaseBackfillStates = p
  .pgTable(
    "database_backfill_states",
    {
      name: p.text().primaryKey(),
      cursor: p.text(),
      batch: jsonb().$type<BatchState>().notNull(),
      updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    },
    () => [
      p.pgPolicy("database_backfill_state_owner_access", {
        for: "all",
        to: "public",
        using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_backfill_states'::regclass)`,
        withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.database_backfill_states'::regclass)`,
      }),
    ],
  )
  .enableRLS();
