import { sql } from "drizzle-orm";

import {
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  storedFileScanState,
  storedFileScanStateCheck,
  timestamptz,
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
    scanState: storedFileScanState(),
    cleanupS3Key: p.varchar("cleanup_s3_key", { length: 512 }),
    sizeBytes: p.integer("size_bytes").notNull(),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
    // Retry count for storage cleanup after this row becomes a tombstone.
    deletionCleanupAttemptCount: p
      .integer("deletion_cleanup_attempt_count")
      .notNull()
      .default(0),
    // Earliest time the tombstone cleanup may run again after a failure.
    deletionCleanupNextAttemptAt: timestamptz(
      "deletion_cleanup_next_attempt_at",
    ),
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
    // A deleted row is the durable receipt for its exact object keys until
    // the storage reconciler confirms erasure.
    p
      .index("style_sets_deletion_cleanup_idx")
      .on(table.deletionCleanupAttemptCount, table.deletedAt, table.id)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    p.check(
      "style_sets_deletion_cleanup_attempt_count_nonnegative_check",
      sql`${table.deletionCleanupAttemptCount} >= 0`,
    ),
    storedFileScanStateCheck("style_sets_scan_state_check", table.scanState),
    p.check(
      "style_sets_s3_key_organization_check",
      sql`starts_with(${table.s3Key}, ${table.organizationId} || '/')`,
    ),
    ...orgPolicies(),
  ],
);
