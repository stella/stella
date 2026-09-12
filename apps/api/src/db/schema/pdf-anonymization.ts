import { sql } from "drizzle-orm";

import type { PdfRasterRewriteCertificate } from "@stll/anonymize-pdf";

import {
  PDF_ANONYMIZATION_ERROR_CODES,
  PDF_ANONYMIZATION_PIPELINE_VERSION,
  PDF_ANONYMIZATION_RUN_ACTIVE_STATUSES,
  PDF_ANONYMIZATION_RUN_STATUSES,
  type PdfAnonymizationErrorCode,
} from "@/api/lib/pdf-anonymization/contract";
import { PDF_MIME_TYPE } from "@/api/mime-types";

import {
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  timestamptz,
  user,
  wsOrganizationPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { entities, entityVersions, fields } from "./entities";

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const STATUS_VALUES = quoted(PDF_ANONYMIZATION_RUN_STATUSES);
const ACTIVE_STATUS_VALUES = quoted(PDF_ANONYMIZATION_RUN_ACTIVE_STATUSES);
const ERROR_CODE_VALUES = quoted(PDF_ANONYMIZATION_ERROR_CODES);

export const pdfAnonymizationRuns = p.pgTable(
  "pdf_anonymization_runs",
  {
    id: pUuid<"pdfAnonymizationRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    sourceFileId: safeUuid<"userFile">("source_file_id").notNull(),
    sourceFileName: p.varchar("source_file_name", { length: 1024 }).notNull(),
    sourceMimeType: p.varchar("source_mime_type", { length: 256 }).notNull(),
    sourceSha256Hex: p.varchar("source_sha256_hex", { length: 64 }).notNull(),
    status: p
      .text("status", { enum: PDF_ANONYMIZATION_RUN_STATUSES })
      .notNull()
      .default("queued"),
    errorCode: p
      .varchar("error_code", { length: 64 })
      .$type<PdfAnonymizationErrorCode>(),
    pageCount: p.integer("page_count"),
    detectionCount: p.integer("detection_count"),
    certificate: jsonb().$type<PdfRasterRewriteCertificate>(),
    outputEntityId: safeUuid<"entity">("output_entity_id"),
    outputFieldId: safeUuid<"field">("output_field_id"),
    outputFileName: p.varchar("output_file_name", { length: 1024 }),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    pipelineVersion: p
      .integer("pipeline_version")
      .notNull()
      .default(PDF_ANONYMIZATION_PIPELINE_VERSION),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    p
      .index("pdf_anonymization_runs_document_created_idx")
      .on(
        table.workspaceId,
        table.entityId,
        table.fileFieldId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    p
      .uniqueIndex("pdf_anonymization_runs_active_document_uidx")
      .on(table.workspaceId, table.entityId, table.fileFieldId)
      .where(sql`${table.status} IN (${ACTIVE_STATUS_VALUES})`),
    p
      .index("pdf_anonymization_runs_queued_created_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    p
      .index("pdf_anonymization_runs_running_started_idx")
      .on(table.startedAt, table.id)
      .where(sql`${table.status} = 'running'`),
    p
      .unique("pdf_anonymization_runs_id_workspace_organization_unq")
      .on(table.id, table.workspaceId, table.organizationId),
    p.check(
      "pdf_anonymization_runs_status_values_check",
      sql`${table.status} IN (${STATUS_VALUES})`,
    ),
    p.check(
      "pdf_anonymization_runs_error_code_values_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${ERROR_CODE_VALUES})`,
    ),
    p.check(
      "pdf_anonymization_runs_source_mime_type_check",
      sql`${table.sourceMimeType} = ${PDF_MIME_TYPE}`,
    ),
    p.check(
      "pdf_anonymization_runs_source_sha256_hex_check",
      sql`${table.sourceSha256Hex} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "pdf_anonymization_runs_pipeline_version_check",
      sql`${table.pipelineVersion} > 0`,
    ),
    p.check(
      "pdf_anonymization_runs_counts_check",
      sql`(${table.pageCount} IS NULL OR ${table.pageCount} >= 1) AND (${table.detectionCount} IS NULL OR ${table.detectionCount} >= 0)`,
    ),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "pdf_anonymization_runs_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityVersionId],
        foreignColumns: [entityVersions.id],
        name: "pdf_anonymization_runs_version_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.fileFieldId, table.workspaceId],
        foreignColumns: [fields.id, fields.workspaceId],
        name: "pdf_anonymization_runs_field_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "pdf_anonymization_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("pdf_anonymization_runs"),
  ],
);
