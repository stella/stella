import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { timestamptz } from "@/api/db/columns";
import { denyStellaAccessPolicies } from "@/api/db/rls";

export const REGISTRATION_BUDGET_KINDS = ["agent", "open-client"] as const;

export const registrationDailyBudget = pgTable(
  "registration_daily_budget",
  {
    day: timestamptz("day").notNull(),
    kind: text("kind", { enum: REGISTRATION_BUDGET_KINDS }).notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.day, table.kind] }),
    check(
      "registration_daily_budget_kind_check",
      sql`${table.kind} in (${sql.join(
        REGISTRATION_BUDGET_KINDS.map((kind) => sql`${kind}`),
        sql`, `,
      )})`,
    ),
    check("registration_daily_budget_count_check", sql`${table.count} > 0`),
    ...denyStellaAccessPolicies(),
  ],
);
