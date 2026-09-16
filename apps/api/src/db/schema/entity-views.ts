import type { ViewLayout } from "@/api/lib/views-schema";

import { entityViewPolicies } from "../rls";
import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  user,
  timestamptz,
} from "./common";

/** Organization-wide, user-owned saved layouts for cross-matter surfaces. */
export const entityViews = p.pgTable(
  "entity_views",
  {
    id: pUuid<"workspaceView">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    layout: p.jsonb().$type<ViewLayout>().notNull(),
    position: p.integer().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("entity_views_org_user_position_idx")
      .on(table.organizationId, table.userId, table.position),
    p.check(
      "entity_views_layout_version_check",
      sql`(jsonb_typeof(${table.layout}) = 'object' AND ${table.layout}->'version' = '1'::jsonb) IS TRUE`,
    ),
    ...entityViewPolicies(),
  ],
);
