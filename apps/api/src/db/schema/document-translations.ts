import { sql } from "drizzle-orm";

import {
  DOCUMENT_TRANSLATION_COMMENT_POLICIES,
  DOCUMENT_TRANSLATION_ENGINES,
  DOCUMENT_TRANSLATION_OUTPUTS,
  DOCUMENT_TRANSLATION_RUN_ACTIVE_STATUSES,
  DOCUMENT_TRANSLATION_RUN_ERROR_CODES,
  DOCUMENT_TRANSLATION_RUN_STATUSES,
  DOCUMENT_TRANSLATION_UNIT_STATUSES,
} from "@/api/lib/document-translation/contract";
import type {
  DocumentTranslationRunErrorCode,
  DocumentTranslationUnitApplication,
} from "@/api/lib/document-translation/contract";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

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
import { entities } from "./entities";

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const RUN_STATUS_VALUES = quoted(DOCUMENT_TRANSLATION_RUN_STATUSES);
const ACTIVE_STATUS_VALUES = quoted(DOCUMENT_TRANSLATION_RUN_ACTIVE_STATUSES);
const ERROR_CODE_VALUES = quoted(DOCUMENT_TRANSLATION_RUN_ERROR_CODES);
const OUTPUT_VALUES = quoted(DOCUMENT_TRANSLATION_OUTPUTS);
const ENGINE_VALUES = quoted(DOCUMENT_TRANSLATION_ENGINES);
const COMMENT_POLICY_VALUES = quoted(DOCUMENT_TRANSLATION_COMMENT_POLICIES);
const UNIT_STATUS_VALUES = quoted(DOCUMENT_TRANSLATION_UNIT_STATUSES);

export const documentTranslationRuns = p.pgTable(
  "document_translation_runs",
  {
    id: pUuid<"documentTranslationRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    sourceFileId: safeUuid<"userFile">("source_file_id").notNull(),
    sourceFileName: p.varchar("source_file_name", { length: 1024 }).notNull(),
    sourceMimeType: p.varchar("source_mime_type", { length: 256 }).notNull(),
    output: p.text("output", { enum: DOCUMENT_TRANSLATION_OUTPUTS }).notNull(),
    engine: p.text("engine", { enum: DOCUMENT_TRANSLATION_ENGINES }).notNull(),
    commentPolicy: p.text("comment_policy", {
      enum: DOCUMENT_TRANSLATION_COMMENT_POLICIES,
    }),
    sourceLang: p.varchar("source_lang", { length: 16 }),
    targetLang: p.varchar("target_lang", { length: 16 }).notNull(),
    status: p
      .text("status", { enum: DOCUMENT_TRANSLATION_RUN_STATUSES })
      .notNull()
      .default("queued"),
    errorCode: p
      .varchar("error_code", { length: 64 })
      .$type<DocumentTranslationRunErrorCode>(),
    total: p.integer().notNull().default(0),
    completed: p.integer().notNull().default(0),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    outputEntityId: safeUuid<"entity">("output_entity_id"),
    outputFieldId: safeUuid<"field">("output_field_id"),
    outputFileName: p.varchar("output_file_name", { length: 1024 }),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    modelRef: p.varchar("model_ref", { length: 256 }),
    pipelineVersion: p.integer("pipeline_version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    p
      .index("document_translation_runs_document_created_idx")
      .on(
        table.workspaceId,
        table.entityId,
        table.fileFieldId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    p
      .uniqueIndex("document_translation_runs_active_document_uidx")
      .on(table.workspaceId, table.entityId, table.fileFieldId)
      .where(sql`${table.status} IN (${ACTIVE_STATUS_VALUES})`),
    p
      .unique("document_translation_runs_id_workspace_organization_unq")
      .on(table.id, table.workspaceId, table.organizationId),
    p.check(
      "document_translation_runs_status_values_check",
      sql`${table.status} IN (${RUN_STATUS_VALUES})`,
    ),
    p.check(
      "document_translation_runs_error_code_values_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${ERROR_CODE_VALUES})`,
    ),
    p.check(
      "document_translation_runs_output_values_check",
      sql`${table.output} IN (${OUTPUT_VALUES})`,
    ),
    p.check(
      "document_translation_runs_engine_values_check",
      sql`${table.engine} IN (${ENGINE_VALUES})`,
    ),
    p.check(
      "document_translation_runs_comment_policy_check",
      sql`${table.commentPolicy} IS NULL OR (${table.sourceMimeType} = ${DOCX_MIME_TYPE} AND ${table.commentPolicy} IN (${COMMENT_POLICY_VALUES}))`,
    ),
    p.check(
      "document_translation_runs_combination_check",
      sql`${table.output} = 'translated' OR ${table.engine} = 'ai'`,
    ),
    p.check(
      "document_translation_runs_ai_source_lang_check",
      sql`${table.engine} <> 'ai' OR (${table.sourceLang} IS NOT NULL AND ${table.sourceLang} <> 'auto')`,
    ),
    p.check(
      "document_translation_runs_progress_check",
      sql`${table.total} >= 0 AND ${table.completed} >= 0 AND ${table.completed} <= ${table.total}`,
    ),
    p.check(
      "document_translation_runs_pipeline_version_check",
      sql`${table.pipelineVersion} > 0`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "document_translation_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("document_translation_runs"),
  ],
);

export const documentTranslationUnits = p.pgTable(
  "document_translation_units",
  {
    id: pUuid<"documentTranslationUnit">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: safeUuid<"documentTranslationRun">("run_id").notNull(),
    unitKey: p.varchar("unit_key", { length: 512 }).notNull(),
    ordinal: p.integer().notNull(),
    sourceText: p.text("source_text").notNull(),
    targetText: p.text("target_text"),
    application: jsonb().$type<DocumentTranslationUnitApplication>().notNull(),
    status: p
      .text("status", { enum: DOCUMENT_TRANSLATION_UNIT_STATUSES })
      .notNull()
      .default("pending"),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("document_translation_units_run_key_uidx")
      .on(table.runId, table.unitKey),
    p
      .index("document_translation_units_run_ordinal_idx")
      .on(table.runId, table.ordinal),
    p.check(
      "document_translation_units_status_values_check",
      sql`${table.status} IN (${UNIT_STATUS_VALUES})`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "document_translation_units_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.runId, table.workspaceId, table.organizationId],
        foreignColumns: [
          documentTranslationRuns.id,
          documentTranslationRuns.workspaceId,
          documentTranslationRuns.organizationId,
        ],
        name: "document_translation_units_run_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("document_translation_units"),
  ],
);
