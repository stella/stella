import { sql } from "drizzle-orm";

import {
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  user,
  timestamptz,
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
    cleanupS3Key: p.varchar("cleanup_s3_key", { length: 512 }),
    sizeBytes: p.integer("size_bytes").notNull(),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [
    p.index("style_sets_organization_id_idx").on(table.organizationId),
    p
      .index("style_sets_organization_id_updated_at_idx")
      .on(table.organizationId, table.updatedAt, table.id),
    // The cleanup reconciler's keyset walk over packages a replacement left
    // behind. Partial so it stays the size of the outstanding work, not of
    // the table.
    p
      .index("style_sets_pending_package_cleanup_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.cleanupS3Key} IS NOT NULL`),
    ...orgPolicies(),
  ],
);
