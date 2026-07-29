import type { SavedSearchCriteria } from "@/api/lib/saved-searches";

import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  savedSearchPolicies,
  sql,
  user,
} from "./common";

export const savedSearches = p.pgTable(
  "saved_searches",
  {
    id: pUuid<"savedSearch">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    criteria: p.jsonb().$type<SavedSearchCriteria>().notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("saved_searches_org_user_updated_id_idx")
      .on(table.organizationId, table.userId, table.updatedAt, table.id),
    p.check(
      "saved_searches_criteria_version_check",
      sql`jsonb_typeof(${table.criteria}) = 'object' AND ${table.criteria}->>'version' = '1'`,
    ),
    ...savedSearchPolicies(),
  ],
);
