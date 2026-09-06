import type { DocumentTranslationSourceLanguageCode } from "@stll/api-contract/document-translation";

import { DESKTOP_EDIT_FILE_TYPES } from "@/api/lib/desktop-edit-file-types";
import {
  FOLIO_COLLAB_CHECKPOINT_MAX_BYTES,
  FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT,
  FOLIO_COLLAB_ROOM_SEED_STATES,
  FOLIO_COLLAB_ROOM_UNSEEDED_STATES,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
} from "@/api/lib/folio-collab-room-contract";

import {
  AGENDA_AVAILABILITIES,
  AGENDA_ITEM_KINDS,
  AGENDA_ITEM_SOURCES,
  AGENDA_SENSITIVITIES,
  ENTITY_DELETION_CLEANUP_STATUSES,
  DESTRUCTIVE_EFFECT_CHUNK_STATUSES,
  ENTITY_KINDS,
  LIST_ITEM_TYPES,
  TASK_ASSIGNEE_ROLES,
  isNotNull,
  jsonb,
  organization,
  organizationCheck,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  timestamptz,
  user,
  workspaceCheck,
  wsOrganizationPolicies,
  wsPolicies,
} from "./common";
import type {
  AgendaAttendee,
  AgendaExternalData,
  AgendaParticipant,
  AgendaRecurrence,
  AnyPgColumn,
  BoundingBoxes,
  CellMetadata,
  DestructiveEffectChunkStatus,
  DocumentSource,
  EntityDeletionCleanupStatus,
  FieldContent,
  JustificationContent,
  LinkMetadata,
  SafeId,
} from "./common";
import { workspaces } from "./contacts";
import { properties } from "./properties";

const LIST_ITEM_TYPE_SQL_VALUES = LIST_ITEM_TYPES.map((itemType) =>
  sql.raw(`'${itemType}'`),
);

const ENTITY_DELETION_CLEANUP_STATUS_SQL_VALUES =
  ENTITY_DELETION_CLEANUP_STATUSES.map((status) => sql.raw(`'${status}'`));
const DESTRUCTIVE_EFFECT_CHUNK_STATUS_SQL_VALUES =
  DESTRUCTIVE_EFFECT_CHUNK_STATUSES.map((status) => sql.raw(`'${status}'`));

export const entities = p.pgTable(
  "entities",
  {
    id: pUuid<"entity">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: p.text("kind", { enum: ENTITY_KINDS }).notNull().default("document"),
    listItemType: p.text("list_item_type", { enum: LIST_ITEM_TYPES }),
    parentId: safeUuid<"entity">("parent_id").references(
      (): AnyPgColumn => entities.id,
      {
        onDelete: "set null",
      },
    ),
    name: p.text("name").notNull(),
    displayName: p
      .varchar("display_name", { length: 512 })
      .notNull()
      .default("Untitled"),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    lastEditedBy: p
      .text("last_edited_by")
      .references(() => user.id, { onDelete: "set null" }),
    currentVersionId: safeUuid<"entityVersion">(
      "current_version_id",
    ).references((): AnyPgColumn => entityVersions.id, {
      onDelete: "restrict",
    }),
    /** Sequential document number within the workspace (null for folders). */
    docSequence: p.integer("doc_sequence"),
    status: p.varchar({ length: 32 }),
    priority: p.varchar({ length: 16 }),
    dueDate: p.date("due_date", { mode: "string" }),
    agendaKind: p.text("agenda_kind", { enum: AGENDA_ITEM_KINDS }),
    startAt: timestamptz("start_at"),
    endAt: timestamptz("end_at"),
    occurredAt: timestamptz("occurred_at"),
    remindAt: timestamptz("remind_at"),
    allDay: p.boolean("all_day").notNull().default(false),
    timeZone: p.varchar("time_zone", { length: 64 }),
    location: p.text("location"),
    onlineMeetingUrl: p.text("online_meeting_url"),
    availability: p.text("availability", { enum: AGENDA_AVAILABILITIES }),
    sensitivity: p.text("sensitivity", { enum: AGENDA_SENSITIVITIES }),
    organizer: jsonb("organizer").$type<AgendaParticipant | null>(),
    attendees: jsonb("attendees").$type<AgendaAttendee[] | null>(),
    recurrence: jsonb("recurrence").$type<AgendaRecurrence | null>(),
    agendaSource: p.text("agenda_source", { enum: AGENDA_ITEM_SOURCES }),
    externalSource: p.varchar("external_source", { length: 64 }),
    externalId: p.varchar("external_id", { length: 256 }),
    externalChangeKey: p.varchar("external_change_key", { length: 512 }),
    externalICalUid: p.varchar("external_ical_uid", { length: 512 }),
    externalData: jsonb("external_data").$type<AgendaExternalData | null>(),
    readOnly: p.boolean("read_only").notNull().default(false),
    sortOrder: p.varchar("sort_order", { length: 64 }),
    /** Structured metadata for non-document entity kinds (e.g. links). */
    metadata: jsonb().$type<LinkMetadata | null>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").defaultNow(),
  },
  (table) => [
    p.index("entities_workspace_id_idx").on(table.workspaceId),
    p
      .index("entities_ws_created_at_id_idx")
      .on(table.workspaceId, table.createdAt, table.id),
    p
      .index("entities_ws_updated_at_id_idx")
      .on(table.workspaceId, table.updatedAt, table.id),
    p
      .index("entities_ws_updated_at_coalesce_id_idx")
      .on(
        table.workspaceId,
        sql`COALESCE(${table.updatedAt}, '0001-01-01 00:00:00+00'::timestamptz)`,
        table.id,
      ),
    p
      .index("entities_ws_display_name_id_idx")
      .on(table.workspaceId, table.displayName, table.id),
    p
      .index("entities_ws_kind_created_at_id_idx")
      .on(table.workspaceId, table.kind, table.createdAt, table.id),
    p
      .index("entities_parent_id_idx")
      .on(table.parentId)
      .where(isNotNull(table.parentId)),
    p.index("entities_workspace_name_idx").on(table.workspaceId, table.name),
    p
      .uniqueIndex("entities_ws_doc_seq_uidx")
      .on(table.workspaceId, table.docSequence)
      .where(isNotNull(table.docSequence)),
    p.unique("entities_id_ws_unq").on(table.id, table.workspaceId),
    p
      .index("entities_workspace_status_idx")
      .on(table.workspaceId, table.status)
      .where(isNotNull(table.status)),
    p
      .index("entities_workspace_priority_idx")
      .on(table.workspaceId, table.priority)
      .where(isNotNull(table.priority)),
    p
      .index("entities_due_date_idx")
      .on(table.workspaceId, table.dueDate)
      .where(isNotNull(table.dueDate)),
    p.check(
      "entities_list_item_type_task_only",
      sql`${table.listItemType} IS NULL OR (${table.kind} = 'task' AND ${table.listItemType} IN (${sql.join(LIST_ITEM_TYPE_SQL_VALUES, sql`, `)}))`,
    ),
    p
      .index("entities_agenda_kind_idx")
      .on(table.workspaceId, table.agendaKind)
      .where(isNotNull(table.agendaKind)),
    p
      .index("entities_agenda_start_at_idx")
      .on(table.workspaceId, table.startAt)
      .where(isNotNull(table.startAt)),
    p
      .index("entities_agenda_occurred_at_idx")
      .on(table.workspaceId, table.occurredAt)
      .where(isNotNull(table.occurredAt)),
    p
      .uniqueIndex("entities_agenda_external_uidx")
      .on(table.workspaceId, table.externalSource, table.externalId)
      .where(isNotNull(table.externalId)),
    p
      .index("entities_agenda_ical_uid_idx")
      .on(table.workspaceId, table.externalICalUid)
      .where(isNotNull(table.externalICalUid)),
    ...wsPolicies(),
  ],
);

/**
 * Durable S3 cleanup work created in the same transaction as an entity delete.
 *
 * This table has NO foreign keys, to any ancestor, including `organization`.
 * That is load-bearing, not an oversight, and `entities.test.ts` fails if one
 * is added. The reason is that `s3_keys` is the only surviving record of which
 * objects to erase: every S3 deletion in the codebase is key-driven from rows
 * like this one (`deleteS3Keys` in `lib/files/utils.ts`), nothing anywhere
 * lists an S3 prefix, and the documents bucket expires only `tmp/` and
 * `exports/` keys, never a finalized `{org}/{workspace}/{file}` key. So a
 * cascade here does not clean up: it destroys the erasure instructions while
 * the objects they name still exist, and no later process can rediscover them.
 *
 * Adding an ancestor reference is therefore only safe once that ancestor's
 * deletion performs its own storage teardown. Until then the row must outlive
 * every ancestor, and tenancy stays a plain column that the RLS policy reads.
 */
export const entityDeletionCleanupRequests = p.pgTable(
  "entity_deletion_cleanup_requests",
  {
    id: pUuid<"entityDeletionCleanupRequest">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    /**
     * The matter whose storage this page erases, or null for keys the
     * organization owns directly (`{org}/templates/…`, `{org}/style-sets/…`,
     * and the user-prefixed chat objects, none of which sit under a matter).
     * Organization deletion records both kinds, so the column states which
     * scope a page came from rather than forcing a matter onto keys that
     * never had one.
     */
    workspaceId: safeWorkspaceId("workspace_id"),
    s3Keys: p.text("s3_keys").array().notNull(),
    status: p
      .text("status", { enum: ENTITY_DELETION_CLEANUP_STATUSES })
      .$type<EntityDeletionCleanupStatus>()
      .notNull()
      .default("pending"),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    errorMessage: p.text("error_message"),
    nextAttemptAt: timestamptz("next_attempt_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    p
      .index("entity_deletion_cleanup_pending_schedule_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    p
      .index("entity_deletion_cleanup_failed_schedule_idx")
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.status} = 'failed'`),
    p
      .index("entity_deletion_cleanup_processing_lease_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.status} = 'processing'`),
    p.check(
      "entity_deletion_cleanup_status_values_check",
      sql`${table.status} IN (${sql.join(ENTITY_DELETION_CLEANUP_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "entity_deletion_cleanup_attempt_count_nonnegative_check",
      sql`${table.attemptCount} >= 0`,
    ),
    // The delete request may create this outbox row through its scoped
    // transaction; all later reads and state transitions are root-worker only.
    p.pgPolicy("entity_deletion_cleanup_insert", {
      for: "insert",
      to: stella,
      withCheck: sql`(workspace_id IS NULL OR ${workspaceCheck}) AND ${organizationCheck}`,
    }),
  ],
);

/**
 * Root-worker-only, bounded S3 deletion effects materialized from one durable
 * entity-cleanup request.
 */
export const entityDeletionEffectChunks = p.pgTable.withRLS(
  "entity_deletion_effect_chunks",
  {
    id: pUuid<"entityDeletionEffectChunk">().primaryKey(),
    requestId: safeUuid<"entityDeletionCleanupRequest">("request_id").notNull(),
    chunkIndex: p.integer("chunk_index").notNull(),
    effectType: p
      .text("effect_type", { enum: ["s3_delete"] })
      .notNull()
      .default("s3_delete"),
    payloadHash: p.varchar("payload_hash", { length: 64 }).notNull(),
    s3Keys: p.text("s3_keys").array().notNull(),
    status: p
      .text("status", { enum: DESTRUCTIVE_EFFECT_CHUNK_STATUSES })
      .$type<DestructiveEffectChunkStatus>()
      .notNull()
      .default("pending"),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    leaseToken: safeUuid<"effectLease">("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    nextAttemptAt: timestamptz("next_attempt_at"),
    errorMessage: p.text("error_message"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.requestId],
        foreignColumns: [entityDeletionCleanupRequests.id],
        name: "entity_deletion_effect_chunks_request_fk",
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("entity_deletion_effect_chunks_request_index_uidx")
      .on(table.requestId, table.chunkIndex),
    p
      .index("entity_deletion_effect_chunks_pending_claim_idx")
      .on(table.requestId, table.chunkIndex)
      .where(sql`${table.status} = 'pending'`),
    p
      .index("entity_deletion_effect_chunks_failed_claim_idx")
      .on(table.nextAttemptAt, table.requestId, table.chunkIndex)
      .where(sql`${table.status} = 'failed'`),
    p
      .index("entity_deletion_effect_chunks_lease_expiry_idx")
      .on(table.leaseExpiresAt, table.requestId, table.chunkIndex)
      .where(sql`${table.status} = 'processing'`),
    p.check(
      "entity_deletion_effect_chunks_status_check",
      sql`${table.status} IN (${sql.join(DESTRUCTIVE_EFFECT_CHUNK_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "entity_deletion_effect_chunks_effect_type_check",
      sql`${table.effectType} = 's3_delete'`,
    ),
    p.check(
      "entity_deletion_effect_chunks_attempt_nonnegative_check",
      sql`${table.attemptCount} >= 0`,
    ),
    p.check(
      "entity_deletion_effect_chunks_index_nonnegative_check",
      sql`${table.chunkIndex} >= 0`,
    ),
    p.check(
      "entity_deletion_effect_chunks_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "entity_deletion_effect_chunks_payload_bound_check",
      sql`(${table.status} = 'completed' AND cardinality(${table.s3Keys}) = 0) OR (${table.status} <> 'completed' AND cardinality(${table.s3Keys}) BETWEEN 1 AND 50)`,
    ),
    p.check(
      "entity_deletion_effect_chunks_lease_state_check",
      sql`(${table.status} = 'processing') = (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    p.check(
      "entity_deletion_effect_chunks_retry_state_check",
      sql`(${table.status} = 'failed') = (${table.nextAttemptAt} IS NOT NULL)`,
    ),
  ],
);

export const taskAssignees = p.pgTable(
  "task_assignees",
  {
    id: pUuid<"taskAssignee">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: p.text("role", { enum: TASK_ASSIGNEE_ROLES }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("task_assignees_workspace_id_idx").on(table.workspaceId),
    p.index("task_assignees_entity_id_idx").on(table.entityId),
    p.index("task_assignees_user_id_idx").on(table.userId),
    p
      .uniqueIndex("task_assignees_entity_user_uidx")
      .on(table.entityId, table.userId),
    ...wsPolicies(),
  ],
);

export const entityLinks = p.pgTable(
  "entity_links",
  {
    id: pUuid<"entityLink">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceEntityId: safeUuid<"entity">("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetEntityId: safeUuid<"entity">("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    linkType: p
      .varchar("link_type", { length: 32 })
      .notNull()
      .default("related"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("entity_links_workspace_id_idx").on(table.workspaceId),
    p.index("entity_links_source_idx").on(table.sourceEntityId),
    p.index("entity_links_target_idx").on(table.targetEntityId),
    p
      .uniqueIndex("entity_links_source_target_uidx")
      .on(table.sourceEntityId, table.targetEntityId),
    p
      .uniqueIndex("entity_links_pair_uidx")
      .using(
        "btree",
        sql`LEAST(${table.sourceEntityId}, ${table.targetEntityId})`,
        sql`GREATEST(${table.sourceEntityId}, ${table.targetEntityId})`,
      ),
    p.check(
      "entity_links_no_self_ref_check",
      sql`${table.sourceEntityId} != ${table.targetEntityId}`,
    ),
    ...wsPolicies(),
  ],
);

export const entityVersions = p.pgTable(
  "entity_versions",
  {
    id: pUuid<"entityVersion">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    versionNumber: p.integer("version_number").notNull().default(1),
    /** Frozen human-readable reference (e.g. "2026/001/015.v3"). */
    stamp: p.varchar("stamp", { length: 128 }),
    /** User-assigned workflow label (e.g. "Internal draft", "Final version"). */
    label: p.varchar("label", { length: 128 }),
    /** Free-text note describing this version. */
    description: p.varchar("description", { length: 1024 }),
    /** Word-level diff stats vs previous version (computed on finalization). */
    diffWordsAdded: p.integer("diff_words_added"),
    diffWordsRemoved: p.integer("diff_words_removed"),
    /** Globally unique verification code (no stl: prefix). */
    verificationCode: p.varchar("verification_code", {
      length: 16,
    }),
    /** User who created this version (uploader, desktop editor, or restorer). */
    createdBy: p.text("created_by"),
    /**
     * Provenance of this version's bytes (see {@link DocumentSource}). A
     * discriminated union, not a boolean: `upload` / `desktop-edit` today,
     * with a `sharepoint` branch reserved for the read-only Graph import
     * slice. Null on legacy rows and creation paths not yet threaded.
     */
    source: jsonb("source").$type<DocumentSource | null>(),
    collaborationContributorUserIds: jsonb(
      "collaboration_contributor_user_ids",
    ).$type<string[] | null>(),
    /**
     * The document's own language, primarily as declared by the DOCX `w:lang`
     * run defaults (see `lib/document-translation/docx-language.ts`), stored
     * as a `DOCUMENT_TRANSLATION_SOURCE_LANGUAGES` code -- BCP-47 shaped, e.g.
     * `CS`, `EN-GB`, `PT-PT`. Null means not detected, or not a DOCX at all.
     *
     * Written once, by whichever of the two producers reaches the row first:
     * native extraction at ingestion (declaration only), or the
     * translation-preparation endpoint when it inspects a version that
     * predates the column (declaration, then text detection). There is no
     * backfill, so a null on an old version is expected rather than a fault.
     */
    detectedLanguage: p
      .varchar("detected_language", { length: 10 })
      .$type<DocumentTranslationSourceLanguageCode>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    /**
     * Chain-of-custody tombstone. A non-null `deletedAt` hides the version
     * from every read / list / restore / download path while its row and S3
     * objects are retained under legal hold: version history must never be
     * hard-deleted. `deletedBy` mirrors `createdBy` (plain user id, no FK) so
     * the actor survives a user deletion.
     */
    deletedAt: timestamptz("deleted_at"),
    deletedBy: p.text("deleted_by"),
  },
  (table) => [
    p
      .uniqueIndex("entity_versions_id_entity_ws_uidx")
      .on(table.id, table.entityId, table.workspaceId),
    p
      .uniqueIndex("entity_versions_entity_number_uidx")
      .on(table.entityId, table.versionNumber),
    p.check(
      "entity_versions_collaboration_contributors_check",
      sql`${table.collaborationContributorUserIds} IS NULL OR (jsonb_typeof(${table.collaborationContributorUserIds}) = 'array' AND jsonb_array_length(${table.collaborationContributorUserIds}) <= ${FOLIO_COLLAB_CONTRIBUTOR_MAX_COUNT})`,
    ),
    p.index("entity_versions_entity_id_idx").on(table.entityId),
    p
      .index("entity_versions_stamp_idx")
      .on(table.stamp)
      .where(isNotNull(table.stamp)),
    p
      .uniqueIndex("entity_versions_vcode_uidx")
      .on(table.verificationCode)
      .where(isNotNull(table.verificationCode)),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p.index("entity_versions_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

export const entityVersionAiSummaries = p.pgTable(
  "entity_version_ai_summaries",
  {
    id: pUuid<"entityVersionAiSummary">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    promptVersion: p.smallint("prompt_version").notNull(),
    sourceTextHash: p.varchar("source_text_hash", { length: 64 }).notNull(),
    summary: p.text().notNull(),
    language: p.varchar("language", { length: 10 }),
    modelProvider: p.varchar("model_provider", { length: 64 }).notNull(),
    modelId: p.varchar("model_id", { length: 256 }).notNull(),
    generatedAt: timestamptz("generated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("entity_version_ai_summaries_workspace_idx").on(table.workspaceId),
    p.index("entity_version_ai_summaries_entity_idx").on(table.entityId),
    p
      .uniqueIndex("entity_version_ai_summaries_version_prompt_uidx")
      .on(table.entityVersionId, table.promptVersion),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "entity_version_ai_summaries_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("entity_version_ai_summaries"),
  ],
);

export const DESKTOP_EDIT_SESSION_STATUSES = [
  "open",
  "finalized",
  "cancelled",
  // Set by the scheduler sweep when a session's token TTL lapses while
  // still "open"; treated as closed everywhere "open" is required.
  "expired",
] as const;

const DESKTOP_EDIT_FILE_TYPE_SQL_VALUES = sql.raw(
  DESKTOP_EDIT_FILE_TYPES.map((fileType) => `'${fileType}'`).join(", "),
);

export type FolioCollabTokenPermissions = {
  canEdit: boolean;
};

export const desktopEditSessions = p.pgTable(
  "desktop_edit_sessions",
  {
    id: pUuid<"desktopEditSession">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    baseVersionId: safeUuid<"entityVersion">("base_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    finalizedVersionId: safeUuid<"entityVersion">(
      "finalized_version_id",
    ).references(() => entityVersions.id, { onDelete: "set null" }),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: p
      .text("status", { enum: DESKTOP_EDIT_SESSION_STATUSES })
      .notNull()
      .default("open"),
    fileType: p.text("file_type", { enum: DESKTOP_EDIT_FILE_TYPES }).notNull(),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    checkpointFileId: safeUuid<"userFile">("checkpoint_file_id").notNull(),
    checkpointSha256Hex: p.varchar("checkpoint_sha256_hex", { length: 64 }),
    checkpointSizeBytes: p.integer("checkpoint_size_bytes"),
    checkpointScanWarnings: jsonb("checkpoint_scan_warnings").$type<
      string[] | null
    >(),
    checkpointUpdatedAt: timestamptz("checkpoint_updated_at"),
    sessionTokenHash: p.varchar("session_token_hash", { length: 64 }).notNull(),
    tokenExpiresAt: timestamptz("token_expires_at").notNull(),
    takeoverRequestedBy: p
      .text("takeover_requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    takeoverRequestedAt: timestamptz("takeover_requested_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: timestamptz("closed_at"),
    expiryNotificationPublishedAt: timestamptz(
      "expiry_notification_published_at",
    ),
  },
  (table) => [
    p.index("desktop_edit_sessions_workspace_id_idx").on(table.workspaceId),
    p.index("desktop_edit_sessions_entity_id_idx").on(table.entityId),
    p.index("desktop_edit_sessions_property_id_idx").on(table.propertyId),
    p
      .index("desktop_edit_sessions_base_version_id_idx")
      .on(table.baseVersionId),
    p
      .uniqueIndex("desktop_edit_sessions_session_token_hash_uidx")
      .on(table.sessionTokenHash),
    p
      .uniqueIndex("desktop_edit_sessions_open_uidx")
      .on(table.createdBy, table.entityId, table.propertyId)
      .where(sql`${table.status} = 'open'`),
    // Selects the oldest live session per entity for table/window reads.
    p
      .index("desktop_edit_sessions_live_entity_created_id_idx")
      .on(table.workspaceId, table.entityId, table.createdAt, table.id)
      .where(sql`${table.status} = 'open'`),
    // Serves the hourly expiry sweep: scan open sessions ordered by token TTL.
    p
      .index("desktop_edit_sessions_open_token_expires_idx")
      .on(table.tokenExpiresAt)
      .where(sql`${table.status} = 'open'`),
    p
      .index("desktop_edit_sessions_expired_unnotified_idx")
      .on(table.closedAt)
      .where(
        sql`${table.status} = 'expired' AND ${table.expiryNotificationPublishedAt} IS NULL`,
      ),
    p.check(
      "desktop_edit_sessions_file_type_check",
      sql`${table.fileType} in (${DESKTOP_EDIT_FILE_TYPE_SQL_VALUES})`,
    ),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    ...wsPolicies(),
  ],
);

export type DesktopEditLinkedAccountSnapshot = {
  email: string;
  name: string | null;
  verifiedAt: string;
};

export const desktopEditHandoffs = p.pgTable(
  "desktop_edit_handoffs",
  {
    id: pUuid<"desktopEditHandoff">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: p.varchar("token_hash", { length: 64 }).notNull(),
    apiBaseUrl: p.text("api_base_url").notNull(),
    linkedAccount: jsonb(
      "linked_account",
    ).$type<DesktopEditLinkedAccountSnapshot | null>(),
    forceTakeover: p.boolean("force_takeover").notNull().default(false),
    expiresAt: timestamptz("expires_at").notNull(),
    consumedAt: timestamptz("consumed_at"),
    desktopSessionId: safeUuid<"desktopEditSession">("desktop_session_id"),
    openedAt: timestamptz("opened_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.index("desktop_edit_handoffs_workspace_id_idx").on(table.workspaceId),
    p.index("desktop_edit_handoffs_expires_at_idx").on(table.expiresAt),
    p
      .index("desktop_edit_handoffs_workspace_created_by_idx")
      .on(table.workspaceId, table.createdBy),
    p.uniqueIndex("desktop_edit_handoffs_token_hash_uidx").on(table.tokenHash),
    p
      .foreignKey({
        columns: [table.desktopSessionId],
        foreignColumns: [desktopEditSessions.id],
        name: "desktop_edit_handoffs_desktop_session_fk",
      })
      .onDelete("set null"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    ...wsPolicies(),
  ],
);

const FOLIO_COLLAB_ROOM_SEED_STATE_SQL_VALUES = sql.raw(
  FOLIO_COLLAB_ROOM_SEED_STATES.map((state) => `'${state}'`).join(", "),
);
const FOLIO_COLLAB_ROOM_UNSEEDED_STATE_SQL_VALUES = sql.raw(
  FOLIO_COLLAB_ROOM_UNSEEDED_STATES.map((state) => `'${state}'`).join(", "),
);

export const folioCollabRooms = p.pgTable(
  "folio_collab_rooms",
  {
    id: pUuid<"folioCollabRoom">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    generation: p.bigint("generation", { mode: "number" }).notNull().default(0),
    baseVersionId: safeUuid<"entityVersion">("base_version_id").notNull(),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    yjsSnapshotFileId: safeUuid<"userFile">("yjs_snapshot_file_id").notNull(),
    yjsSnapshotRevision: p
      .bigint("yjs_snapshot_revision", { mode: "number" })
      .notNull()
      .default(0),
    yjsSnapshotSizeBytes: p.integer("yjs_snapshot_size_bytes"),
    yjsSnapshotUpdatedAt: timestamptz("yjs_snapshot_updated_at"),
    docxCheckpointFileId: safeUuid<"userFile">(
      "docx_checkpoint_file_id",
    ).notNull(),
    docxCheckpointSha256Hex: p.varchar("docx_checkpoint_sha256_hex", {
      length: 64,
    }),
    docxCheckpointSizeBytes: p.integer("docx_checkpoint_size_bytes"),
    docxCheckpointScanWarnings: jsonb("docx_checkpoint_scan_warnings").$type<
      string[] | null
    >(),
    docxCheckpointUpdatedAt: timestamptz("docx_checkpoint_updated_at"),
    seedState: p
      .text("seed_state", { enum: FOLIO_COLLAB_ROOM_SEED_STATES })
      .notNull()
      .default("empty"),
    seedClaimedBy: p.text("seed_claimed_by").references(() => user.id, {
      onDelete: "set null",
    }),
    seedClaimedAt: timestamptz("seed_claimed_at"),
    seededAt: timestamptz("seeded_at"),
    lastActivityAt: timestamptz("last_activity_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("folio_collab_rooms_target_uidx")
      .on(table.workspaceId, table.entityId, table.propertyId),
    p
      .uniqueIndex("folio_collab_rooms_id_workspace_uidx")
      .on(table.id, table.workspaceId),
    p
      .index("folio_collab_rooms_workspace_entity_idx")
      .on(table.workspaceId, table.entityId),
    p
      .index("folio_collab_rooms_workspace_property_idx")
      .on(table.workspaceId, table.propertyId),
    p
      .index("folio_collab_rooms_workspace_activity_idx")
      .on(table.workspaceId, table.lastActivityAt),
    p.check(
      "folio_collab_rooms_generation_check",
      sql`${table.generation} >= 0`,
    ),
    p.check(
      "folio_collab_rooms_snapshot_revision_check",
      sql`${table.yjsSnapshotRevision} >= 0`,
    ),
    p.check(
      "folio_collab_rooms_snapshot_revision_seed_check",
      sql`(
        (${table.seedState} IN (${FOLIO_COLLAB_ROOM_UNSEEDED_STATE_SQL_VALUES}) AND ${table.yjsSnapshotRevision} = 0)
        OR (${table.seedState} = 'seeded' AND ${table.yjsSnapshotRevision} > 0)
      )`,
    ),
    p.check(
      "folio_collab_rooms_seed_state_check",
      sql`${table.seedState} in (${FOLIO_COLLAB_ROOM_SEED_STATE_SQL_VALUES})`,
    ),
    p.check(
      "folio_collab_rooms_seed_fields_check",
      sql`(
        (${table.seedState} = 'empty' AND ${table.seedClaimedBy} IS NULL AND ${table.seedClaimedAt} IS NULL AND ${table.seededAt} IS NULL AND ${table.yjsSnapshotSizeBytes} IS NULL AND ${table.yjsSnapshotUpdatedAt} IS NULL)
        OR (${table.seedState} = 'claimed' AND ${table.seedClaimedBy} IS NOT NULL AND ${table.seedClaimedAt} IS NOT NULL AND ${table.seededAt} IS NULL AND ${table.yjsSnapshotSizeBytes} IS NULL AND ${table.yjsSnapshotUpdatedAt} IS NULL)
        OR (${table.seedState} = 'seeded' AND ${table.seedClaimedAt} IS NOT NULL AND ${table.seededAt} IS NOT NULL AND ${table.yjsSnapshotSizeBytes} IS NOT NULL AND ${table.yjsSnapshotUpdatedAt} IS NOT NULL)
      )`,
    ),
    p.check(
      "folio_collab_rooms_snapshot_size_check",
      sql`${table.yjsSnapshotSizeBytes} IS NULL OR (${table.yjsSnapshotSizeBytes} >= 0 AND ${table.yjsSnapshotSizeBytes} <= ${FOLIO_COLLAB_SNAPSHOT_MAX_BYTES})`,
    ),
    p.check(
      "folio_collab_rooms_checkpoint_size_check",
      sql`${table.docxCheckpointSizeBytes} IS NULL OR (${table.docxCheckpointSizeBytes} >= 0 AND ${table.docxCheckpointSizeBytes} <= ${FOLIO_COLLAB_CHECKPOINT_MAX_BYTES})`,
    ),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "folio_collab_rooms_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
        name: "folio_collab_rooms_property_workspace_fk",
      })
      .onDelete("cascade"),
    p.foreignKey({
      columns: [table.baseVersionId, table.entityId, table.workspaceId],
      foreignColumns: [
        entityVersions.id,
        entityVersions.entityId,
        entityVersions.workspaceId,
      ],
      name: "folio_collab_rooms_base_version_entity_workspace_fk",
    }),
    ...wsPolicies(),
  ],
);

export const folioCollabRoomTokens = p.pgTable(
  "folio_collab_room_tokens",
  {
    id: pUuid<"folioCollabRoomToken">().primaryKey(),
    roomId: safeUuid<"folioCollabRoom">("room_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: p.varchar("token_hash", { length: 64 }).notNull(),
    generation: p.bigint("generation", { mode: "number" }).notNull(),
    permissions: jsonb("permissions")
      .$type<FolioCollabTokenPermissions>()
      .notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("folio_collab_room_tokens_workspace_expiry_idx")
      .on(table.workspaceId, table.expiresAt),
    p.index("folio_collab_room_tokens_room_id_idx").on(table.roomId),
    p.index("folio_collab_room_tokens_user_id_idx").on(table.userId),
    p
      .uniqueIndex("folio_collab_room_tokens_token_hash_uidx")
      .on(table.tokenHash),
    p
      .foreignKey({
        columns: [table.roomId, table.workspaceId],
        foreignColumns: [folioCollabRooms.id, folioCollabRooms.workspaceId],
        name: "folio_collab_room_tokens_room_workspace_fk",
      })
      .onDelete("cascade"),
    p.check(
      "folio_collab_room_tokens_generation_check",
      sql`${table.generation} >= 0`,
    ),
    ...wsPolicies(),
  ],
);

// Contribution rows are capped per room and reset after every publication;
// deleting the durable room cascades any unpublished remainder.
export const folioCollabContributions = p.pgTable(
  "folio_collab_contributions",
  {
    id: pUuid<"folioCollabContribution">().primaryKey(),
    roomId: safeUuid<"folioCollabRoom">("room_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sinceVersionId: safeUuid<"entityVersion">("since_version_id").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("folio_collab_contributions_room_user_uidx")
      .on(table.roomId, table.userId),
    p
      .index("folio_collab_contributions_workspace_room_idx")
      .on(table.workspaceId, table.roomId),
    p
      .foreignKey({
        columns: [table.roomId, table.workspaceId],
        foreignColumns: [folioCollabRooms.id, folioCollabRooms.workspaceId],
        name: "folio_collab_contributions_room_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.sinceVersionId, table.entityId, table.workspaceId],
        foreignColumns: [
          entityVersions.id,
          entityVersions.entityId,
          entityVersions.workspaceId,
        ],
        name: "folio_collab_contributions_version_entity_workspace_fk",
      })
      .onDelete("cascade"),
    ...wsPolicies(),
  ],
);

// Publications are the durable idempotency ledger for immutable versions.
// Their lifetime intentionally matches the room/version history they protect.
export const folioCollabPublications = p.pgTable(
  "folio_collab_publications",
  {
    id: pUuid<"folioCollabPublication">().primaryKey(),
    roomId: safeUuid<"folioCollabRoom">("room_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id").notNull(),
    idempotencyKey: p.varchar("idempotency_key", { length: 128 }).notNull(),
    generation: p.bigint("generation", { mode: "number" }).notNull(),
    checkpointSha256Hex: p
      .varchar("checkpoint_sha256_hex", { length: 64 })
      .notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("folio_collab_publications_idempotency_uidx")
      .on(table.idempotencyKey),
    p
      .index("folio_collab_publications_workspace_room_idx")
      .on(table.workspaceId, table.roomId),
    p.check(
      "folio_collab_publications_generation_check",
      sql`${table.generation} >= 0`,
    ),
    p
      .foreignKey({
        columns: [table.roomId, table.workspaceId],
        foreignColumns: [folioCollabRooms.id, folioCollabRooms.workspaceId],
        name: "folio_collab_publications_room_workspace_fk",
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
        name: "folio_collab_publications_version_entity_workspace_fk",
      })
      .onDelete("cascade"),
    ...wsPolicies(),
  ],
);

/**
 * Lifecycle of a single presigned upload, from the moment the API
 * issues a PUT URL to the moment the resulting entity (or version,
 * skill, attachment...) is committed.
 *
 * - "pending":   URL issued, client may or may not have uploaded yet
 * - "scanning":  finalize handler claimed the row and is doing S3 I/O
 * - "finalized": domain rows committed; `finalizedResult` populated
 * - "rejected":  scan refused the upload; tmp deleted; terminal
 * - "failed":    transient error (S3 5xx, DB error after S3 success);
 *                claim can re-fire after `claimedAt + grace`
 */
export const PENDING_UPLOAD_STATUSES = [
  "pending",
  "scanning",
  "finalized",
  "rejected",
  "failed",
] as const;

export type PendingUploadStatus = (typeof PENDING_UPLOAD_STATUSES)[number];

const PENDING_UPLOAD_RECOVERY_POLICY = {
  pending: "not-recoverable",
  scanning: "recoverable",
  finalized: "not-recoverable",
  rejected: "not-recoverable",
  failed: "recoverable",
} as const satisfies Record<
  PendingUploadStatus,
  "not-recoverable" | "recoverable"
>;

type RecoverablePendingUploadStatus = {
  [TStatus in PendingUploadStatus]: (typeof PENDING_UPLOAD_RECOVERY_POLICY)[TStatus] extends "recoverable"
    ? TStatus
    : never;
}[PendingUploadStatus];

const isRecoverablePendingUploadStatus = (
  status: PendingUploadStatus,
): status is RecoverablePendingUploadStatus =>
  PENDING_UPLOAD_RECOVERY_POLICY[status] === "recoverable";

export const PENDING_UPLOAD_RECOVERABLE_STATUSES =
  PENDING_UPLOAD_STATUSES.filter(isRecoverablePendingUploadStatus);

/**
 * Each upload purpose drives a different finalize transaction (entity
 * vs. version vs. skill...). The discriminator lives in its own column
 * so phase-2 surfaces (`entity_version`, `agent_skill`, `chat_attachment`)
 * can be added without a schema migration — only `purposeData` and
 * `finalizedResult` shapes change.
 */
export const PENDING_UPLOAD_PURPOSES = [
  "entity_create",
  "entity_version",
  "agent_skill",
] as const;

export type PendingUploadPurposeData =
  | {
      type: "entity_create";
      propertyId: SafeId<"property">;
      /**
       * Final object id reserved by trusted server-side writers. Persisting it
       * before S3 publication lets the bounded reconciler derive and remove a
       * final-key object left behind by a hard process death.
       */
      reservedFileId?: string;
    }
  | {
      type: "entity_version";
      entityId: SafeId<"entity">;
      /**
       * Final object id reserved by trusted server-side writers. Persisting it
       * before S3 publication lets the bounded reconciler derive and remove a
       * final-key object left behind by a hard process death.
       */
      reservedFileId?: string;
    }
  | {
      type: "agent_skill";
      // "team" requires admin/owner role; "private" is per-user.
      // Kept inline (not aliased to `AgentSkillScope`) because that
      // type is declared further down the file.
      scope: "team" | "private";
    };

export type PendingUploadFinalizedResult =
  | {
      type: "entity_create";
      entityId: SafeId<"entity">;
      /** UUIDv7 stored on `fields.content.id`; not a branded SafeId. */
      fileId: string;
      fileName: string;
      renamed: boolean;
    }
  | {
      type: "entity_version";
      entityId: SafeId<"entity">;
      entityVersionId: SafeId<"entityVersion">;
      versionNumber: number;
      fileId: string;
      fileName: string;
    }
  | {
      type: "agent_skill";
      skillId: SafeId<"agentSkill">;
      name: string;
      version: string;
    };

export const pendingUploads = p.pgTable(
  "pending_uploads",
  {
    id: pUuid<"pendingUpload">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: p.text("purpose", { enum: PENDING_UPLOAD_PURPOSES }).notNull(),
    purposeData: jsonb("purpose_data")
      .$type<PendingUploadPurposeData>()
      .notNull(),
    declaredName: p.varchar("declared_name", { length: 255 }).notNull(),
    declaredMime: p.varchar("declared_mime", { length: 255 }).notNull(),
    declaredSize: p.bigint("declared_size", { mode: "number" }).notNull(),
    /** hex; matches `fields.content.sha256Hex` storage shape */
    declaredSha256: p.varchar("declared_sha256", { length: 64 }).notNull(),
    status: p
      .text("status", { enum: PENDING_UPLOAD_STATUSES })
      .notNull()
      .default("pending"),
    /** Populated on success so retries return the same response shape. */
    finalizedResult: jsonb(
      "finalized_result",
    ).$type<PendingUploadFinalizedResult | null>(),
    rejectReason: p.text("reject_reason"),
    /** Set inside the claim transaction. Used to detect stuck `scanning` rows. */
    claimedAt: timestamptz("claimed_at"),
    claimedByRequestId: p.varchar("claimed_by_request_id", { length: 64 }),
    /** `createdAt + 5min`. A finalize after this rejects without touching S3. */
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    finalizedAt: timestamptz("finalized_at"),
  },
  (table) => [
    p
      .index("pending_uploads_ws_status_created_idx")
      .on(table.workspaceId, table.status, table.createdAt),
    p
      .index("pending_uploads_org_created_idx")
      .on(table.organizationId, table.createdAt),
    p
      .index("pending_uploads_buffer_intent_recovery_idx")
      .on(table.claimedAt, table.id)
      .where(
        sql`${table.status} IN ('scanning', 'failed')
          AND ${table.purpose} IN ('entity_create', 'entity_version')
          AND ${table.purposeData}->>'reservedFileId' IS NOT NULL`,
      ),
    p
      .foreignKey({
        name: "pending_uploads_organization_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "pending_uploads_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("pending_uploads"),
  ],
);

export const BUFFER_OBJECT_CLEANUP_INTENT_STATUS = {
  ORPHANED: "orphaned",
  RECOVERING: "recovering",
  WRITING: "writing",
} as const;

/**
 * Durable tombstones for server-generated object writes interrupted by a
 * workspace, organization, or account deletion.
 *
 * This table has NO foreign keys, to any ancestor, including `organization`,
 * and `entities.test.ts` fails if one is added. The tombstone is the only
 * record that a reserved key may still be published: recovery must outlive the
 * owner cascade and the cleanup that interrupted the write, until the original
 * writer confirms it can no longer publish or the bounded late-write
 * quarantine completes. Matter writers reserve a finalized
 * `{org}/{workspace}/{file}` key; organization-scoped chat writers reserve
 * their `{user}/{file}` key with a null workspace. No bucket lifecycle rule
 * expires either class and no prefix sweep can rediscover one.
 *
 * Adding an ancestor reference is therefore only safe once that ancestor's
 * deletion performs its own storage teardown. Until then tenancy stays a plain
 * column that the RLS policy reads.
 */
export const bufferObjectCleanupIntents = p.pgTable(
  "buffer_object_cleanup_intents",
  {
    id: pUuid<"pendingUpload">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id"),
    // Deliberately not a foreign key: the cleanup proof must outlive its chat.
    chatThreadId: safeUuid<"chatThread">("chat_thread_id"),
    // No FK: a writer must retain settlement authority after its owning
    // workspace, thread, or organization has been removed.
    writerUserId: p
      .text("writer_user_id")
      .$type<SafeId<"user">>()
      // PostgreSQL deparses this built-in without its implicit pg_catalog
      // qualifier and with an explicit text cast; matching that canonical form
      // keeps schema parity stable.
      .default(sql`current_setting('app.user_id'::text, true)`),
    objectKey: p.text("object_key").notNull(),
    status: p
      .text({
        enum: [
          BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED,
          BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING,
          BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
        ],
      })
      .notNull()
      .default(BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => {
    const ownerScopeAccess = sql`((
      ${table.chatThreadId} IS NOT NULL
      AND pg_catalog.split_part(${table.objectKey}, '/', 1) = (SELECT pg_catalog.current_setting('app.user_id', true))
      AND EXISTS (
        SELECT 1 FROM chat_threads ct
        WHERE ct.id = ${table.chatThreadId}
          AND ct.organization_id = ${table.organizationId}
          AND ct.user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
          AND (
            (${table.workspaceId} IS NULL AND ct.workspace_id IS NULL AND pg_catalog.cardinality(ct.data_workspace_ids) = 0)
            OR (${table.workspaceId} IS NOT NULL AND (ct.workspace_id = ${table.workspaceId} OR ct.data_workspace_ids @> ARRAY[${table.workspaceId}]::uuid[]))
          )
      )
    ) OR (
      ${table.chatThreadId} IS NULL
      AND ${table.workspaceId} IS NOT NULL
      AND ${workspaceCheck}
      AND pg_catalog.split_part(${table.objectKey}, '/', 1) = ${table.organizationId}
      AND pg_catalog.split_part(${table.objectKey}, '/', 2) = ${table.workspaceId}::text
    ))`;
    const writerSettlementAccess = sql`
      ${table.writerUserId} = (SELECT pg_catalog.current_setting('app.user_id', true))
    `;
    const scopedAccess = sql`${organizationCheck} AND (${ownerScopeAccess} OR ${writerSettlementAccess})`;
    // Template writers reserve only new attempt keys beneath an existing,
    // tenant-visible template. Settlement remains exclusive to the stamped
    // writer; this does not grant another member access to its live intent.
    const templateWriteAccess = sql`(
      ${table.chatThreadId} IS NULL
      AND ${table.workspaceId} IS NULL
      AND pg_catalog.split_part(${table.objectKey}, '/', 1) = ${table.organizationId}
      AND pg_catalog.split_part(${table.objectKey}, '/', 2) = 'templates'
      AND pg_catalog.split_part(${table.objectKey}, '/', 4) ~ '^write-[0-9a-f-]{36}[.]docx$'
      AND pg_catalog.array_length(pg_catalog.string_to_array(${table.objectKey}, '/'), 1) = 4
      AND EXISTS (
        SELECT 1 FROM templates t
        WHERE t.organization_id = ${table.organizationId}
          AND t.id::text = pg_catalog.split_part(${table.objectKey}, '/', 3)
      )
    )`;

    return [
      p
        .index("buffer_object_cleanup_schedule_idx")
        .on(table.nextAttemptAt, table.id),
      p
        .index("buffer_object_cleanup_workspace_idx")
        .on(table.workspaceId, table.id),
      p
        .index("buffer_object_cleanup_organization_idx")
        .on(table.organizationId, table.id),
      p.check(
        "buffer_object_cleanup_attempt_count_nonnegative_check",
        sql`${table.attemptCount} >= 0`,
      ),
      p.check(
        "buffer_object_cleanup_status_check",
        sql`${table.status} IN (${BUFFER_OBJECT_CLEANUP_INTENT_STATUS.ORPHANED}, ${BUFFER_OBJECT_CLEANUP_INTENT_STATUS.RECOVERING}, ${BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING})`,
      ),
      // Lifecycle deletion may transfer the intent through its scoped
      // transaction. The original scoped writer may remove it only after its
      // PUT settles and exact-key cleanup succeeds. Scoped reads expose only the
      // opaque id and state needed for that lock; recovery reads stay root-only.
      p.pgPolicy("buffer_object_cleanup_insert", {
        for: "insert",
        to: stella,
        withCheck: sql`${organizationCheck} AND ${writerSettlementAccess} AND (${ownerScopeAccess} OR ${templateWriteAccess})`,
      }),
      p.pgPolicy("buffer_object_cleanup_select", {
        for: "select",
        to: stella,
        using: scopedAccess,
      }),
      p.pgPolicy("buffer_object_cleanup_update", {
        for: "update",
        to: stella,
        using: scopedAccess,
      }),
      p.pgPolicy("buffer_object_cleanup_delete", {
        for: "delete",
        to: stella,
        using: scopedAccess,
      }),
    ];
  },
);

export const fields = p.pgTable(
  "fields",
  {
    id: pUuid<"field">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    fileId: safeUuid<"userFile">("file_id"),
    content: jsonb().$type<FieldContent>().notNull(),
  },
  (table) => [
    p
      .uniqueIndex("fields_property_id_entity_version_id_key")
      .on(table.propertyId, table.entityVersionId),
    p
      .index("fields_ws_entity_version_property_idx")
      .on(table.workspaceId, table.entityVersionId, table.propertyId),
    p
      .index("fields_pending_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.content}->>'type' = 'pending'`),
    p
      .index("fields_workspace_file_mime_entity_version_id_idx")
      .on(
        table.workspaceId,
        sql`(${table.content}->>'mimeType')`,
        table.entityVersionId,
        table.id,
      )
      .where(sql`${table.content}->>'type' = 'file'`),
    // Bounded document-processing recovery has a global ID cursor, so its
    // partial candidate index must start with that cursor column.
    p
      .index("fields_document_processing_native_candidate_idx")
      .on(table.id, table.workspaceId, table.entityVersionId)
      .where(
        sql`${table.content}->>'type' = 'file'
          AND ${table.content}->>'encrypted' = 'false'`,
      ),
    // The `files.repairDerivatives` sweep pages by a global id cursor too, and
    // its steady state is an empty candidate set: without a partial index
    // matching its predicate, every tick would scan the table to find nothing.
    p
      .index("fields_derivative_repair_candidate_idx")
      .on(table.id)
      .where(
        sql`${table.content}->>'type' = 'file'
          AND (
            coalesce(${table.content}->'pdfDerivative'->>'status', 'pending')
              NOT IN ('ready', 'not-required')
            OR coalesce(${table.content}->'thumbnailDerivative'->>'status', 'pending')
              NOT IN ('ready', 'not-required')
          )`,
      ),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    p.index("fields_workspace_id_idx").on(table.workspaceId),
    p.unique("fields_id_ws_unq").on(table.id, table.workspaceId),
    ...wsPolicies(),
  ],
);

export const cellMetadata = p.pgTable(
  "cell_metadata",
  {
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    propertyId: safeUuid<"property">("property_id").notNull(),
    metadata: jsonb().$type<CellMetadata>().notNull(),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    updatedBy: p
      .text("updated_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.entityVersionId, table.propertyId],
      name: "cell_metadata_entity_version_id_property_id_pk",
    }),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
        name: "cell_metadata_property_workspace_fk",
      })
      .onDelete("cascade"),
    p.index("cell_metadata_workspace_id_idx").on(table.workspaceId),
    p.index("cell_metadata_entity_version_id_idx").on(table.entityVersionId),
    ...wsPolicies(),
  ],
);

export const justifications = p.pgTable(
  "justifications",
  {
    id: pUuid<"justification">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    fieldId: safeUuid<"field">("field_id").notNull(),
    content: jsonb().$type<JustificationContent>().notNull(),
    boundingBoxes: jsonb("bounding_boxes").$type<BoundingBoxes>(),
    fileFieldIds: safeUuid<"field">("file_field_ids")
      .array()
      .notNull()
      .default([]),
  },
  (table) => [
    p.uniqueIndex("justifications_field_id_key").on(table.fieldId),
    p
      .foreignKey({
        columns: [table.fieldId, table.workspaceId],
        foreignColumns: [fields.id, fields.workspaceId],
      })
      .onDelete("cascade"),
    p.index("justifications_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

/** Structural kind of a stored template. `document` templates fill into a
 *  single output document; `report` templates are the layout for a view→report
 *  export (repeating {{#each}} sections). The picker filters on this so a report
 *  export never offers a plain document template and vice versa. */
export const TEMPLATE_KINDS = ["document", "report"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
