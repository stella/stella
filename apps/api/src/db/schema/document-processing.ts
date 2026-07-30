import { sql } from "drizzle-orm";

import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  user,
  wsOrganizationReadOnlyPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { entities, entityVersions, fields } from "./entities";

/**
 * The work performed for a document source. Keep this a discriminator rather
 * than an OCR boolean: future processors can share the immutable-source and
 * durable-retry contract without a schema rewrite.
 */
export const DOCUMENT_PROCESSING_KINDS = ["ocr"] as const;
export type DocumentProcessingKind = (typeof DOCUMENT_PROCESSING_KINDS)[number];

/** Durable lifecycle for one immutable processing request. */
export const DOCUMENT_PROCESSING_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type DocumentProcessingStatus =
  (typeof DOCUMENT_PROCESSING_STATUSES)[number];

/** Why a processing request exists; distinct sources can have distinct policy. */
export const DOCUMENT_PROCESSING_REQUEST_SOURCES = [
  "upload",
  "manual",
  "repair",
] as const;
export type DocumentProcessingRequestSource =
  (typeof DOCUMENT_PROCESSING_REQUEST_SOURCES)[number];

/**
 * Durable execution record for processing one immutable document source.
 *
 * The source identity is intentionally denormalized and unique: a retry, a
 * duplicate enqueue, or a repair scan all converge on the same run. The row
 * holds operational metadata only; OCR output remains in its own encrypted
 * projection rather than being duplicated here.
 */
export const documentProcessingRuns = p.pgTable(
  "document_processing_runs",
  {
    id: pUuid<"documentProcessingRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    fieldId: safeUuid<"field">("field_id").notNull(),
    /** UUIDv7 stored in `fields.content.id`; deliberately not a table FK. */
    sourceFileId: p.uuid("source_file_id").notNull(),
    sourceSha256Hex: p.varchar("source_sha256_hex", { length: 64 }).notNull(),
    kind: p.text({ enum: DOCUMENT_PROCESSING_KINDS }).notNull(),
    /** Bump when a processor's persisted-output contract changes. */
    processorVersion: p.integer("processor_version").notNull().default(1),
    requestSource: p
      .text("request_source", {
        enum: DOCUMENT_PROCESSING_REQUEST_SOURCES,
      })
      .notNull(),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    status: p
      .text({ enum: DOCUMENT_PROCESSING_STATUSES })
      .notNull()
      .default("queued"),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    progressCompleted: p.integer("progress_completed").notNull().default(0),
    progressTotal: p.integer("progress_total"),
    errorCode: p.varchar("error_code", { length: 128 }),
    errorAt: p.timestamp("error_at", { withTimezone: true }),
    claimedAt: p.timestamp("claimed_at", { withTimezone: true }),
    claimedBy: p.varchar("claimed_by", { length: 128 }),
    nextAttemptAt: p.timestamp("next_attempt_at", { withTimezone: true }),
    startedAt: p.timestamp("started_at", { withTimezone: true }),
    finishedAt: p.timestamp("finished_at", { withTimezone: true }),
    createdAt: p
      .timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: p
      .timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("document_processing_runs_source_uidx")
      .on(
        table.organizationId,
        table.kind,
        table.entityVersionId,
        table.fieldId,
        table.sourceFileId,
        table.sourceSha256Hex,
        table.processorVersion,
      ),
    p
      .index("document_processing_runs_org_status_next_attempt_idx")
      .on(
        table.organizationId,
        table.status,
        table.nextAttemptAt,
        table.createdAt,
        table.id,
      ),
    p
      .index("document_processing_runs_workspace_created_idx")
      .on(table.workspaceId, table.createdAt.desc(), table.id),
    p
      .index("document_processing_runs_workspace_entity_created_idx")
      .on(table.workspaceId, table.entityId, table.createdAt.desc(), table.id),
    /**
     * System worker reconciliation is intentionally cross-tenant and bounded;
     * this partial index prevents its oldest-first queued scan from degrading
     * into a full-table scan.
     */
    p
      .index("document_processing_runs_queued_schedule_idx")
      .on(table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    p
      .index("document_processing_runs_running_lease_idx")
      .on(table.claimedAt, table.id)
      .where(sql`${table.status} = 'running'`),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "document_processing_runs_version_fk",
        columns: [table.entityVersionId],
        foreignColumns: [entityVersions.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.fieldId, table.workspaceId],
        foreignColumns: [fields.id, fields.workspaceId],
      })
      .onDelete("cascade"),
    p.check(
      "document_processing_runs_kind_values_check",
      sql`${table.kind} IN ('ocr')`,
    ),
    p.check(
      "document_processing_runs_status_values_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    p.check(
      "document_processing_runs_request_source_values_check",
      sql`${table.requestSource} IN ('upload', 'manual', 'repair')`,
    ),
    p.check(
      "document_processing_runs_processor_version_positive_check",
      sql`${table.processorVersion} > 0`,
    ),
    p.check(
      "document_processing_runs_attempt_count_nonnegative_check",
      sql`${table.attemptCount} >= 0`,
    ),
    p.check(
      "document_processing_runs_progress_nonnegative_check",
      sql`${table.progressCompleted} >= 0 AND (${table.progressTotal} IS NULL OR ${table.progressTotal} >= 0)`,
    ),
    p.check(
      "document_processing_runs_progress_within_total_check",
      sql`${table.progressTotal} IS NULL OR ${table.progressCompleted} <= ${table.progressTotal}`,
    ),
    p.check(
      "document_processing_runs_source_sha256_hex_check",
      sql`${table.sourceSha256Hex} ~ '^[0-9a-f]{64}$'`,
    ),
    ...wsOrganizationReadOnlyPolicies("document_processing_runs"),
  ],
);
