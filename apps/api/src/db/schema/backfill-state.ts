import type { BatchState } from "@stll/db-load-gate/health";

import { jsonb, p, timestamptz } from "./common";

/** System maintenance state; application roles have no policy or table grant. */
export const databaseBackfillStates = p
  .pgTable("database_backfill_states", {
    name: p.text().primaryKey(),
    cursor: p.text(),
    batch: jsonb().$type<BatchState>().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  })
  .enableRLS();
