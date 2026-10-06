import {
  p,
  sql,
  timestamptz,
  user,
  organization,
  safeOrganizationId,
  userOrganizationPolicies,
} from "./common";

// One current observation per installation; membership or account removal erases it.
export const desktopPresence = p.pgTable(
  "desktop_presence",
  {
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    desktopId: p.uuid("desktop_id").notNull(),
    version: p.varchar({ length: 64 }).notNull(),
    protocol: p.integer().notNull(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      name: "desktop_presence_pkey",
      columns: [table.userId, table.organizationId, table.desktopId],
    }),
    p
      .index("desktop_presence_user_seen_idx")
      .on(table.userId, table.organizationId, table.lastSeenAt.desc()),
    p.check("desktop_presence_protocol_check", sql`${table.protocol} >= 0`),
    ...userOrganizationPolicies(),
  ],
);
