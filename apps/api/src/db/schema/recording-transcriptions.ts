import { sql } from "drizzle-orm";

import {
  RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES,
  RECORDING_TRANSCRIPTION_RUN_ERROR_CODES,
  RECORDING_TRANSCRIPTION_RUN_SETTLED_STATUSES,
  RECORDING_TRANSCRIPTION_RUN_STATUSES,
} from "@stll/api-contract/recording-transcription";
import type { RecordingTranscriptionRunErrorCode } from "@stll/api-contract/recording-transcription";

import {
  entityFeatureGateChecks,
  entityFeatureGateColumns,
} from "../entity-feature-gate-columns";
import {
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
import { entities, entityVersions } from "./entities";

const quoted = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

// The run's reconciler writes through the owner connection.
const isOwner = sql.raw(
  `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.recording_transcription_runs'::regclass)`,
);

const RUN_STATUS_VALUES = quoted(RECORDING_TRANSCRIPTION_RUN_STATUSES);
const ACTIVE_STATUS_VALUES = quoted(
  RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES,
);
const ERROR_CODE_VALUES = quoted(RECORDING_TRANSCRIPTION_RUN_ERROR_CODES);
const SETTLED_STATUS_VALUES = quoted(
  RECORDING_TRANSCRIPTION_RUN_SETTLED_STATUSES,
);

export const recordingTranscriptionRuns = p.pgTable(
  "recording_transcription_runs",
  {
    ...entityFeatureGateColumns(),
    id: pUuid<"recordingTranscriptionRun">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fileFieldId: safeUuid<"field">("file_field_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    sourceFileId: safeUuid<"userFile">("source_file_id").notNull(),
    sourceFileName: p.varchar("source_file_name", { length: 1024 }).notNull(),
    sourceMimeType: p.varchar("source_mime_type", { length: 256 }).notNull(),
    status: p
      .text("status", { enum: RECORDING_TRANSCRIPTION_RUN_STATUSES })
      .notNull()
      .default("queued"),
    errorCode: p
      .varchar("error_code", { length: 64 })
      .$type<RecordingTranscriptionRunErrorCode>(),
    durationMs: p.integer("duration_ms"),
    transcribedMs: p.integer("transcribed_ms").notNull().default(0),
    outputEntityId: safeUuid<"entity">("output_entity_id"),
    outputFieldId: safeUuid<"field">("output_field_id"),
    outputFileName: p.varchar("output_file_name", { length: 1024 }),
    requestedBy: p
      .text("requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    modelRef: p.varchar("model_ref", { length: 256 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
  },
  (table) => [
    ...entityFeatureGateChecks(table),
    p
      .index("recording_transcription_runs_document_created_idx")
      .on(
        table.workspaceId,
        table.entityId,
        table.fileFieldId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    // Deleting an organization cascades to its runs.
    p
      .index("recording_transcription_runs_organization_idx")
      .on(table.organizationId),
    // The feature gate looks runs up by their pinned version.
    p
      .index("recording_transcription_runs_workspace_version_idx")
      .on(table.workspaceId, table.entityVersionId),
    // The reconciler's sweeps read only queued or started runs.
    p
      .index("recording_transcription_runs_queued_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued'`),
    p
      .index("recording_transcription_runs_started_idx")
      .on(table.startedAt, table.id)
      .where(sql`${table.status} IN ('transcribing', 'saving')`),
    p
      .uniqueIndex("recording_transcription_runs_active_document_uidx")
      .on(table.workspaceId, table.entityId, table.fileFieldId)
      .where(sql`${table.status} IN (${ACTIVE_STATUS_VALUES})`),
    p.check(
      "recording_transcription_runs_status_values_check",
      sql`${table.status} IN (${RUN_STATUS_VALUES})`,
    ),
    p.check(
      "recording_transcription_runs_error_code_values_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${ERROR_CODE_VALUES})`,
    ),
    // A completed run names its transcript, a failed one its reason, and
    // only a settled run has finished.
    p.check(
      "recording_transcription_runs_state_fields_check",
      sql`(${table.status} = 'completed') = (${table.outputEntityId} IS NOT NULL) AND (${table.status} = 'failed') = (${table.errorCode} IS NOT NULL) AND (${table.status} IN (${SETTLED_STATUS_VALUES})) = (${table.finishedAt} IS NOT NULL)`,
    ),
    p.check(
      "recording_transcription_runs_progress_check",
      sql`${table.transcribedMs} >= 0 AND (${table.durationMs} IS NULL OR ${table.durationMs} >= 0)`,
    ),
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "recording_transcription_runs_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
        name: "recording_transcription_runs_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "recording_transcription_runs_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "recording_transcription_runs_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityVersionId, table.entityId, table.workspaceId],
        foreignColumns: [
          entityVersions.id,
          entityVersions.entityId,
          entityVersions.workspaceId,
        ],
        name: "recording_transcription_runs_version_fk",
      })
      .onDelete("cascade"),
    p.pgPolicy("recording_transcription_runs_owner", {
      for: "all",
      to: "public",
      using: isOwner,
      withCheck: isOwner,
    }),
    ...wsOrganizationPolicies("recording_transcription_runs", {
      columns: table,
      references: new Map([
        [
          table.entityVersionId,
          { target: "entity_versions", kind: "owned-content" },
        ],
        [table.entityId, { target: "entities", kind: "owned-content" }],
      ]),
    }),
    p.index("recording_transcription_runs_ef_entity_id_idx").on(table.entityId),
  ],
);
