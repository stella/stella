import { sql } from "drizzle-orm";

import {
  bytea,
  organization,
  p,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  timestamptz,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { entities, entityVersions, fields } from "./entities";

export const OFFICE_FILE_EVIDENCE_FORMATS = ["xlsx", "pptx"] as const;
export const OFFICE_FILE_EVIDENCE_STATUSES = [
  "available",
  "unavailable",
] as const;

export const officeFileEvidence = p.pgTable(
  "office_file_evidence",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    fieldId: safeUuid<"field">("field_id").notNull(),
    sourceFileId: p.uuid("source_file_id").notNull(),
    sourceSha256Hex: p.varchar("source_sha256_hex", { length: 64 }).notNull(),
    format: p.text("format", { enum: OFFICE_FILE_EVIDENCE_FORMATS }).notNull(),
    parserVersion: p.integer("parser_version").notNull(),
    status: p.text("status", { enum: OFFICE_FILE_EVIDENCE_STATUSES }).notNull(),
    payloadCiphertext: bytea("payload_ciphertext"),
    payloadIv: bytea("payload_iv"),
    blockCount: p.integer("block_count").notNull(),
    errorCode: p.varchar("error_code", { length: 64 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("office_file_evidence_source_uidx")
      .on(
        table.organizationId,
        table.workspaceId,
        table.entityVersionId,
        table.fieldId,
        table.sourceFileId,
        table.sourceSha256Hex,
        table.parserVersion,
      ),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.fieldId, table.workspaceId],
        foreignColumns: [fields.id, fields.workspaceId],
      })
      .onDelete("cascade"),
    p.check(
      "office_file_evidence_format_check",
      sql`${table.format} IN ('xlsx', 'pptx')`,
    ),
    p.check(
      "office_file_evidence_status_check",
      sql`${table.status} IN ('available', 'unavailable')`,
    ),
    p.check(
      "office_file_evidence_parser_version_check",
      sql`${table.parserVersion} > 0`,
    ),
    p.check(
      "office_file_evidence_block_count_check",
      sql`${table.blockCount} >= 0 AND ${table.blockCount} <= 160`,
    ),
    p.check(
      "office_file_evidence_source_hash_check",
      sql`${table.sourceSha256Hex} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "office_file_evidence_payload_state_check",
      sql`(
        ${table.status} = 'available'
        AND ${table.payloadCiphertext} IS NOT NULL
        AND ${table.payloadIv} IS NOT NULL
        AND ${table.errorCode} IS NULL
      ) OR (
        ${table.status} = 'unavailable'
        AND ${table.payloadCiphertext} IS NULL
        AND ${table.payloadIv} IS NULL
        AND ${table.blockCount} = 0
        AND ${table.errorCode} IN ('parse_failed', 'resource_limit')
      )`,
    ),
    ...wsOrganizationPolicies("office_file_evidence"),
  ],
);
