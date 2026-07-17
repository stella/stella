import {
  ENTITY_KINDS,
  LIST_ITEM_TYPES,
  TASK_ASSIGNEE_ROLES,
  isNotNull,
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  user,
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
  FieldContent,
  JustificationContent,
  LinkMetadata,
  SafeId,
} from "./common";
import { workspaces } from "./contacts";
import { properties } from "./properties";

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
    agendaKind: p.text("agenda_kind", {
      enum: ["task", "deadline", "meeting", "hearing", "event"],
    }),
    startAt: p.timestamp("start_at", { withTimezone: true }),
    endAt: p.timestamp("end_at", { withTimezone: true }),
    occurredAt: p.timestamp("occurred_at", { withTimezone: true }),
    remindAt: p.timestamp("remind_at", { withTimezone: true }),
    allDay: p.boolean("all_day").notNull().default(false),
    timeZone: p.varchar("time_zone", { length: 64 }),
    location: p.text("location"),
    onlineMeetingUrl: p.text("online_meeting_url"),
    availability: p.text("availability", {
      enum: [
        "free",
        "tentative",
        "busy",
        "out_of_office",
        "working_elsewhere",
        "unknown",
      ],
    }),
    sensitivity: p.text("sensitivity", {
      enum: ["normal", "private", "confidential"],
    }),
    organizer: jsonb("organizer").$type<AgendaParticipant | null>(),
    attendees: jsonb("attendees").$type<AgendaAttendee[] | null>(),
    recurrence: jsonb("recurrence").$type<AgendaRecurrence | null>(),
    agendaSource: p.text("agenda_source", {
      enum: ["manual", "infosoud", "calendar", "email", "import", "api"],
    }),
    externalSource: p.varchar("external_source", { length: 64 }),
    externalId: p.varchar("external_id", { length: 256 }),
    externalChangeKey: p.varchar("external_change_key", { length: 512 }),
    externalICalUid: p.varchar("external_ical_uid", { length: 512 }),
    externalData: jsonb("external_data").$type<AgendaExternalData | null>(),
    readOnly: p.boolean("read_only").notNull().default(false),
    sortOrder: p.varchar("sort_order", { length: 64 }),
    /** Structured metadata for non-document entity kinds (e.g. links). */
    metadata: jsonb().$type<LinkMetadata | null>(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").defaultNow(),
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
        sql`COALESCE(${table.updatedAt}, '0001-01-01 00:00:00'::timestamp)`,
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
      sql`${table.listItemType} IS NULL OR ${table.kind} = 'task'`,
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
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
    generatedAt: p.timestamp("generated_at").notNull().defaultNow(),
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
    ...wsPolicies(),
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

export const FOLIO_COLLAB_SESSION_STATUSES = [
  "open",
  "finalized",
  "cancelled",
] as const;

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
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    checkpointFileId: safeUuid<"userFile">("checkpoint_file_id").notNull(),
    checkpointSha256Hex: p.varchar("checkpoint_sha256_hex", { length: 64 }),
    checkpointSizeBytes: p.integer("checkpoint_size_bytes"),
    checkpointScanWarnings: jsonb("checkpoint_scan_warnings").$type<
      string[] | null
    >(),
    checkpointUpdatedAt: p.timestamp("checkpoint_updated_at"),
    sessionTokenHash: p.varchar("session_token_hash", { length: 64 }).notNull(),
    tokenExpiresAt: p.timestamp("token_expires_at").notNull(),
    takeoverRequestedBy: p
      .text("takeover_requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    takeoverRequestedAt: p.timestamp("takeover_requested_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: p.timestamp("closed_at"),
    expiryNotificationPublishedAt: p.timestamp(
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
    expiresAt: p.timestamp("expires_at").notNull(),
    consumedAt: p.timestamp("consumed_at"),
    desktopSessionId: safeUuid<"desktopEditSession">(
      "desktop_session_id",
    ).references(() => desktopEditSessions.id, { onDelete: "set null" }),
    openedAt: p.timestamp("opened_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
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

export const folioCollabSessions = p.pgTable(
  "folio_collab_sessions",
  {
    id: pUuid<"folioCollabSession">().primaryKey(),
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
      .text("status", { enum: FOLIO_COLLAB_SESSION_STATUSES })
      .notNull()
      .default("open"),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    yjsSnapshotFileId: safeUuid<"userFile">("yjs_snapshot_file_id").notNull(),
    yjsSnapshotSizeBytes: p.integer("yjs_snapshot_size_bytes"),
    yjsSnapshotUpdatedAt: p.timestamp("yjs_snapshot_updated_at"),
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
    docxCheckpointUpdatedAt: p.timestamp("docx_checkpoint_updated_at"),
    seedClaimedBy: p.text("seed_claimed_by").references(() => user.id, {
      onDelete: "set null",
    }),
    seedClaimedAt: p.timestamp("seed_claimed_at"),
    seededAt: p.timestamp("seeded_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: p.timestamp("closed_at"),
  },
  (table) => [
    p.index("folio_collab_sessions_workspace_id_idx").on(table.workspaceId),
    p.index("folio_collab_sessions_entity_id_idx").on(table.entityId),
    p.index("folio_collab_sessions_property_id_idx").on(table.propertyId),
    p
      .index("folio_collab_sessions_base_version_id_idx")
      .on(table.baseVersionId),
    p
      .uniqueIndex("folio_collab_sessions_open_uidx")
      .on(table.workspaceId, table.entityId, table.propertyId)
      .where(sql`${table.status} = 'open'`),
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

export const folioCollabSessionTokens = p.pgTable(
  "folio_collab_session_tokens",
  {
    id: pUuid<"folioCollabSessionToken">().primaryKey(),
    sessionId: safeUuid<"folioCollabSession">("session_id")
      .notNull()
      .references(() => folioCollabSessions.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: p.varchar("token_hash", { length: 64 }).notNull(),
    permissions: jsonb("permissions")
      .$type<FolioCollabTokenPermissions>()
      .notNull(),
    expiresAt: p.timestamp("expires_at").notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("folio_collab_session_tokens_workspace_id_idx")
      .on(table.workspaceId),
    p.index("folio_collab_session_tokens_session_id_idx").on(table.sessionId),
    p.index("folio_collab_session_tokens_expires_at_idx").on(table.expiresAt),
    p
      .uniqueIndex("folio_collab_session_tokens_token_hash_uidx")
      .on(table.tokenHash),
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
    }
  | {
      type: "entity_version";
      entityId: SafeId<"entity">;
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
    claimedAt: p.timestamp("claimed_at"),
    claimedByRequestId: p.varchar("claimed_by_request_id", { length: 64 }),
    /** `createdAt + 5min`. A finalize after this rejects without touching S3. */
    expiresAt: p.timestamp("expires_at").notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    finalizedAt: p.timestamp("finalized_at"),
  },
  (table) => [
    p
      .index("pending_uploads_ws_status_created_idx")
      .on(table.workspaceId, table.status, table.createdAt),
    p
      .index("pending_uploads_org_created_idx")
      .on(table.organizationId, table.createdAt),
    ...wsPolicies(),
  ],
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
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
