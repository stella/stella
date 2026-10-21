import { inArray, sql } from "drizzle-orm";
import { check, pgPolicy, pgTable, text } from "drizzle-orm/pg-core";

import { timestamptz } from "@/api/db/columns";
import { denyStellaAccessPolicies } from "@/api/db/rls";
import { SYNTHETIC_SESSION_CONTROL_STATUSES } from "@/api/lib/synthetic-principal/constants";

export const syntheticSessionControl = pgTable.withRLS(
  "synthetic_session_control",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: SYNTHETIC_SESSION_CONTROL_STATUSES })
      .notNull()
      .default("enabled"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "synthetic_session_control_id_check",
      sql`${table.id} = 'monitoring-session'`,
    ),
    check(
      "synthetic_session_control_status_check",
      inArray(table.status, SYNTHETIC_SESSION_CONTROL_STATUSES),
    ),
    pgPolicy("synthetic_session_control_owner", {
      for: "all",
      to: "public",
      using: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.synthetic_session_control'::regclass)`,
      withCheck: sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.synthetic_session_control'::regclass)`,
    }),
    ...denyStellaAccessPolicies(),
  ],
);
