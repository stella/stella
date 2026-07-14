import {
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  user,
} from "./common";

export const styleSets = p.pgTable(
  "style_sets",
  {
    id: pUuid<"styleSet">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    s3Key: p.varchar("s3_key", { length: 512 }).notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("style_sets_organization_id_idx").on(table.organizationId),
    p
      .index("style_sets_organization_id_updated_at_idx")
      .on(table.organizationId, table.updatedAt, table.id),
    ...orgPolicies(),
  ],
);
