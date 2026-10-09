import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text } from "drizzle-orm/pg-core";

import { oauthClient, organization } from "@/api/db/auth-schema";
import { denyStellaAccessPolicies } from "@/api/db/rls";

/** Operator-owned service principals; ordinary application sessions have no access. */
export const serviceOAuthClients = pgTable(
  "service_oauth_clients",
  {
    clientId: text("client_id")
      .primaryKey()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    requestsPerMinute: integer("requests_per_minute").notNull(),
    dailyBudget: integer("daily_budget").notNull(),
  },
  (table) => [
    index("service_oauth_clients_organization_id_idx").on(table.organizationId),
    check(
      "service_oauth_clients_limits_check",
      sql`${table.requestsPerMinute} BETWEEN 1 AND 600 AND ${table.dailyBudget} BETWEEN 1 AND 100000`,
    ),
    ...denyStellaAccessPolicies(),
  ],
);
