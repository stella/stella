import { sql } from "drizzle-orm";

import {
  BILINGUAL_DISPOSITION_ORIGINS,
  BILINGUAL_ROW_DISPOSITIONS,
  BILINGUAL_ROW_KINDS,
  BILINGUAL_ROW_STATUSES,
  BILINGUAL_RUN_ACTIVE_STATUSES,
  BILINGUAL_RUN_ERROR_CODES,
  BILINGUAL_RUN_STATUSES,
  BILINGUAL_TABLE_LAYOUTS,
} from "@/api/lib/bilingual/contract";
import type {
  BilingualGlossaryEntry,
  BilingualRunErrorCode,
} from "@/api/lib/bilingual/contract";

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

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

const RUN_STATUS_SQL_VALUES = quoted(BILINGUAL_RUN_STATUSES);
const RUN_ACTIVE_STATUS_SQL_VALUES = quoted(BILINGUAL_RUN_ACTIVE_STATUSES);
const RUN_ERROR_CODE_SQL_VALUES = quoted(BILINGUAL_RUN_ERROR_CODES);
const ROW_DISPOSITION_SQL_VALUES = quoted(BILINGUAL_ROW_DISPOSITIONS);
const ROW_ORIGIN_SQL_VALUES = quoted(BILINGUAL_DISPOSITION_ORIGINS);
const ROW_KIND_SQL_VALUES = quoted(BILINGUAL_ROW_KINDS);
const ROW_STATUS_SQL_VALUES = quoted(BILINGUAL_ROW_STATUSES);
const TABLE_LAYOUT_SQL_VALUES = quoted(BILINGUAL_TABLE_LAYOUTS);

/**
 * One translation of a bilingual document (a two-column table laid out by
 * folio). The run pins the document version it was prepared against; the
 * worker refuses to write into a newer version. The glossary the reviewer
 * confirmed is snapshotted here so the run stays explainable after edits.
 */
export const bilingualTranslationRuns = p.pgTable(
  "bilingual_translation_runs",
  {
    id: pUuid<"bilingualTranslationRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Plain identifiers: a deleted document must not take its run history with
    // it, so these deliberately carry no foreign key.
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    sourceLang: p.varchar("source_lang", { length: 16 }).notNull(),
    targetLang: p.varchar("target_lang", { length: 16 }).notNull(),
    glossary: jsonb().$type<BilingualGlossaryEntry[]>().notNull(),
    status: p
      .text("status", { enum: BILINGUAL_RUN_STATUSES })
      .notNull()
      .default("queued"),
    errorCode: p
      .varchar("error_code", { length: 64 })
      .$type<BilingualRunErrorCode>(),
    // Progress over the rows that need a model call.
    total: p.integer().notNull().default(0),
    completed: p.integer().notNull().default(0),
    // The version the filled document was written as, once completed.
    outputEntityVersionId: safeUuid<"entityVersion">(
      "output_entity_version_id",
    ),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    modelRef: p.varchar("model_ref", { length: 256 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    p
      .index("bilingual_translation_runs_document_created_idx")
      .on(
        table.workspaceId,
        table.entityId,
        table.fileFieldId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    // At most one unfinished run per document; the endpoint answers 409 first,
    // this index makes a lost race impossible.
    p
      .uniqueIndex("bilingual_translation_runs_active_document_uidx")
      .on(table.workspaceId, table.entityId, table.fileFieldId)
      .where(sql`${table.status} IN (${RUN_ACTIVE_STATUS_SQL_VALUES})`),
    p.check(
      "bilingual_translation_runs_status_values_check",
      sql`${table.status} IN (${RUN_STATUS_SQL_VALUES})`,
    ),
    p.check(
      "bilingual_translation_runs_error_code_values_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${RUN_ERROR_CODE_SQL_VALUES})`,
    ),
    p.check(
      "bilingual_translation_runs_progress_check",
      sql`${table.total} >= 0 AND ${table.completed} >= 0 AND ${table.completed} <= ${table.total}`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "bilingual_translation_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("bilingual_translation_runs"),
  ],
);

/**
 * One row of the bilingual table inside a run: its disposition as confirmed
 * by the reviewer, and the translation once produced. `(runId, rowId)` is the
 * upsert key, so a re-delivered batch converges onto the rows it already wrote.
 */
export const bilingualTranslationRows = p.pgTable(
  "bilingual_translation_rows",
  {
    id: pUuid<"bilingualTranslationRow">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Named explicitly: the generated name would exceed Postgres's 63-byte
    // identifier limit and be truncated.
    runId: safeUuid<"bilingualTranslationRun">("run_id").notNull(),
    // The folio row handle: the right-column paragraph's `w14:paraId`, or the
    // paragraph's own id for a paragraph inside a kept table.
    rowId: p.varchar("row_id", { length: 64 }).notNull(),
    ordinal: p.integer().notNull(),
    kind: p.text("kind", { enum: BILINGUAL_ROW_KINDS }).notNull(),
    // A paragraph inside a kept (spanning) table has no right-column copy.
    inTable: p.boolean("in_table").notNull().default(false),
    // Null identifies non-table rows and inline rows created before this
    // discriminator was persisted.
    tableLayout: p.text("table_layout", { enum: BILINGUAL_TABLE_LAYOUTS }),
    disposition: p
      .text("disposition", { enum: BILINGUAL_ROW_DISPOSITIONS })
      .notNull(),
    dispositionOrigin: p
      .text("disposition_origin", { enum: BILINGUAL_DISPOSITION_ORIGINS })
      .notNull(),
    sourceParaId: p.varchar("source_para_id", { length: 64 }),
    sourceText: p.text("source_text").notNull(),
    targetText: p.text("target_text"),
    status: p
      .text("status", { enum: BILINGUAL_ROW_STATUSES })
      .notNull()
      .default("pending"),
    // Deterministic consistency findings (a glossary term rendered
    // differently, a number missing); never auto-fixed.
    warnings: jsonb().$type<string[]>().notNull().default([]),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("bilingual_translation_rows_run_row_uidx")
      .on(table.runId, table.rowId),
    p
      .index("bilingual_translation_rows_run_ordinal_idx")
      .on(table.runId, table.ordinal),
    p.check(
      "bilingual_translation_rows_kind_values_check",
      sql`${table.kind} IN (${ROW_KIND_SQL_VALUES})`,
    ),
    p.check(
      "bilingual_translation_rows_disposition_values_check",
      sql`${table.disposition} IN (${ROW_DISPOSITION_SQL_VALUES})`,
    ),
    p.check(
      "bilingual_translation_rows_origin_values_check",
      sql`${table.dispositionOrigin} IN (${ROW_ORIGIN_SQL_VALUES})`,
    ),
    p.check(
      "bilingual_translation_rows_status_values_check",
      sql`${table.status} IN (${ROW_STATUS_SQL_VALUES})`,
    ),
    p.check(
      "bilingual_translation_rows_table_layout_values_check",
      sql`${table.tableLayout} IS NULL OR ${table.tableLayout} IN (${TABLE_LAYOUT_SQL_VALUES})`,
    ),
    p
      .foreignKey({
        columns: [table.runId],
        foreignColumns: [bilingualTranslationRuns.id],
        name: "bilingual_translation_rows_run_id_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "bilingual_translation_rows_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("bilingual_translation_rows"),
  ],
);
