import { sql } from "drizzle-orm";

import {
  OFFICE_EVIDENCE_FORMATS,
  OFFICE_EVIDENCE_LIMITS,
  OFFICE_EVIDENCE_STATUSES,
  OFFICE_EVIDENCE_STATUS,
  OFFICE_EVIDENCE_UNAVAILABLE_CODES,
} from "@/api/lib/files/office-evidence-domain";

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

const unavailableCodeSql = sql.join(
  OFFICE_EVIDENCE_UNAVAILABLE_CODES.map((code) => sql.raw(`'${code}'`)),
  sql.raw(","),
);
const processingStatusSql = sql.raw(`'${OFFICE_EVIDENCE_STATUS.processing}'`);
const availableStatusSql = sql.raw(`'${OFFICE_EVIDENCE_STATUS.available}'`);
const unavailableStatusSql = sql.raw(`'${OFFICE_EVIDENCE_STATUS.unavailable}'`);

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
    format: p.text("format", { enum: OFFICE_EVIDENCE_FORMATS }).notNull(),
    parserVersion: p.integer("parser_version").notNull(),
    status: p.text("status", { enum: OFFICE_EVIDENCE_STATUSES }).notNull(),
    claimToken: p.uuid("claim_token"),
    claimExpiresAt: timestamptz("claim_expires_at"),
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
      .index("office_file_evidence_workspace_organization_idx")
      .on(table.workspaceId, table.organizationId),
    p
      .index("office_file_evidence_entity_workspace_idx")
      .on(table.entityId, table.workspaceId),
    p
      .index("office_file_evidence_entity_version_idx")
      .on(table.entityVersionId),
    p
      .index("office_file_evidence_field_workspace_idx")
      .on(table.fieldId, table.workspaceId),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "office_file_evidence_workspace_organization_fk",
      })
      .onDelete("cascade"),
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
      sql`${table.format} IN (${sql.join(
        OFFICE_EVIDENCE_FORMATS.map((format) => sql.raw(`'${format}'`)),
        sql.raw(","),
      )})`,
    ),
    p.check(
      "office_file_evidence_status_check",
      sql`${table.status} IN (${sql.join(
        OFFICE_EVIDENCE_STATUSES.map((status) => sql.raw(`'${status}'`)),
        sql.raw(","),
      )})`,
    ),
    p.check(
      "office_file_evidence_parser_version_check",
      sql`${table.parserVersion} > 0`,
    ),
    p.check(
      "office_file_evidence_block_count_check",
      sql`${table.blockCount} >= 0 AND ${table.blockCount} <= ${sql.raw(
        String(OFFICE_EVIDENCE_LIMITS.blocksMax),
      )}`,
    ),
    p.check(
      "office_file_evidence_source_hash_check",
      sql`${table.sourceSha256Hex} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "office_file_evidence_payload_state_check",
      sql`(
        ${table.status} = ${processingStatusSql}
        AND ${table.claimToken} IS NOT NULL
        AND ${table.claimExpiresAt} IS NOT NULL
        AND ${table.payloadCiphertext} IS NULL
        AND ${table.payloadIv} IS NULL
        AND ${table.blockCount} = 0
        AND ${table.errorCode} IS NULL
      ) OR (
        ${table.status} = ${availableStatusSql}
        AND ${table.claimToken} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.payloadCiphertext} IS NOT NULL
        AND ${table.payloadIv} IS NOT NULL
        AND ${table.errorCode} IS NULL
      ) OR (
        ${table.status} = ${unavailableStatusSql}
        AND ${table.claimToken} IS NULL
        AND ${table.claimExpiresAt} IS NULL
        AND ${table.payloadCiphertext} IS NULL
        AND ${table.payloadIv} IS NULL
        AND ${table.blockCount} = 0
        AND ${table.errorCode} IN (${unavailableCodeSql})
      )`,
    ),
    ...wsOrganizationPolicies("office_file_evidence"),
  ],
);
