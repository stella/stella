import { REASONING_EFFORTS } from "@stll/ai-catalog";

import {
  CHAT_TURN_CANCELLATION_REASONS,
  CHAT_TURN_FAILURE_CODES,
  CHAT_TURN_INTERACTION_TYPES,
  CHAT_TURN_INTERRUPTION_REASONS,
  CHAT_TURN_STATUSES,
} from "@/api/handlers/chat/chat-turn-state";

import {
  aiMemoryPolicies,
  CHAT_COMPACTION_MEMORY_ELIGIBILITIES,
  chatMessageSearchDocumentPolicies,
  chatMessagePolicies,
  chatTurnPolicies,
  chatThreadCompactionPolicies,
  chatThreadPreviewPassagePolicies,
  chatThreadSearchDocumentPolicies,
  chatThreadPolicies,
  fileChatThreadPolicies,
  isNotNull,
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  templateChatThreadPolicies,
  tsvector,
  user,
  timestamptz,
} from "./common";
import type {
  AnyPgColumn,
  ChatCompactionMemoryEligibility,
  ChatCompactionSummary,
  ChatMessageRole,
  ChatTitleSource,
  PersistedChatMessageContent,
  SafeId,
} from "./common";
import { workspaces } from "./contacts";
import { entities, fields } from "./entities";
import { templates } from "./templates";

const REASONING_EFFORT_SQL_VALUES = REASONING_EFFORTS.map((effort) =>
  sql.raw(`'${effort}'`),
);

const CHAT_COMPACTION_MEMORY_ELIGIBILITY_SQL_VALUES =
  CHAT_COMPACTION_MEMORY_ELIGIBILITIES.map((eligibility) =>
    sql.raw(`'${eligibility}'`),
  );

const CHAT_TURN_STATUS_SQL_VALUES = CHAT_TURN_STATUSES.map((status) =>
  sql.raw(`'${status}'`),
);

const CHAT_TURN_INTERACTION_TYPE_SQL_VALUES = CHAT_TURN_INTERACTION_TYPES.map(
  (interactionType) => sql.raw(`'${interactionType}'`),
);

const CHAT_TURN_FAILURE_CODE_SQL_VALUES = CHAT_TURN_FAILURE_CODES.map((code) =>
  sql.raw(`'${code}'`),
);

const CHAT_TURN_CANCELLATION_REASON_SQL_VALUES =
  CHAT_TURN_CANCELLATION_REASONS.map((reason) => sql.raw(`'${reason}'`));

const CHAT_TURN_INTERRUPTION_REASON_SQL_VALUES =
  CHAT_TURN_INTERRUPTION_REASONS.map((reason) => sql.raw(`'${reason}'`));

/** Width of `chat_threads.title`; anything deriving a title must fit it. */
export const CHAT_THREAD_TITLE_MAX_LENGTH = 255;

export const chatThreads = p.pgTable(
  "chat_threads",
  {
    id: pUuid<"chatThread">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      {
        onDelete: "restrict",
      },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: p.varchar({ length: CHAT_THREAD_TITLE_MAX_LENGTH }).notNull(),
    // Provenance of `title`; gates whether background AI titling may replace it.
    // See ChatTitleSource in ./common. New threads start "default"; a rename
    // stamps "user"; the generator only replaces "default" and stamps "ai".
    // Length fits the longest value ("default").
    titleSource: p
      .varchar("title_source", { length: 7 })
      .$type<ChatTitleSource>()
      .notNull()
      .default("default"),
    /**
     * A successful mutation adopts a newly created thread, preventing the
     * creating request's disconnect compensation from deleting changed state.
     * Explicit token writes (creation and compare-and-set claim) take priority.
     */
    rollbackToken: p.text("rollback_token").$onUpdate(() => sql`null`),
    /**
     * Matters the chat draws context from. Empty array (the
     * default) means "no specific matters pinned" — the AI
     * discovers matters lazily via the readonly stella API.
     * Non-empty narrows tool authorization so requested matterRefs
     * must be a subset of this set. Distinct from `workspaceId`,
     * which is the matter the chat itself lives under (or null
     * for global threads).
     */
    contextMatterIds: safeWorkspaceId("context_matter_ids")
      .array()
      .notNull()
      .default([]),
    /**
     * Workspaces whose content (citations, document excerpts) is
     * embedded in this thread. Empty means "no workspace data
     * embedded" (true global chat). Any non-empty value gates RLS
     * reads: the user's session workspace IDs must be a superset.
     * Used by search-summary chats so the stored summary cannot
     * outlive the user's access to a contributing matter.
     */
    dataWorkspaceIds: safeWorkspaceId("data_workspace_ids")
      .array()
      .notNull()
      .default([]),
    /**
     * Per-thread opt-in for the chat web-search tools. Combined with
     * the FEATURE_WEB_SEARCH deploy gate and the org's
     * disabled-native-tools list, all three must hold for web_search /
     * fetch_url to be exposed to the model on a turn. Defaults to
     * false so existing threads see no behaviour change after this
     * column lands.
     */
    webSearchEnabled: p.boolean("web_search_enabled").notNull().default(false),
    /**
     * Per-thread chat-role model override, encoded as
     * `"<provider>::<modelId>"` (same encoding as the org AI config's
     * dev model selector). Null means "use the org's chat-role
     * default." The value is validated against the org's configured
     * providers and the model catalog at write time, and re-validated
     * at send time so a provider key removal or a catalog bump that
     * drops the model falls back to the org default instead of
     * failing the send.
     */
    chatModel: p.text("chat_model"),
    /**
     * Explicit effort for a manual `chatModel` selection. Null keeps Stella's
     * adapter default and is always required while `chatModel` is null (Auto).
     * The database migration adds the matching value/pair CHECK.
     */
    chatReasoningEffort: p.text("chat_reasoning_effort", {
      enum: REASONING_EFFORTS,
    }),
    /**
     * Cached "where you left off" recap, shown as subtle grey text
     * below the last message when the user reopens this thread after
     * a gap (see RECAP_STALENESS_THRESHOLD_MS). Derived from the
     * transcript and regenerated lazily when `recapMessageId` no
     * longer matches the latest message or `recapPromptVersion`
     * changes; all four columns stay null until the first stale
     * revisit generates one. `recapMessageId` is a plain cache token
     * (equality-compared only, no FK) so message truncation simply
     * invalidates the cache rather than dangling a reference.
     */
    recapText: p.text("recap_text"),
    recapMessageId: safeUuid<"chatMessage">("recap_message_id"),
    recapPromptVersion: p.smallint("recap_prompt_version"),
    recapGeneratedAt: timestamptz("recap_generated_at"),
    usedAnonymization: p.boolean("used_anonymization").notNull().default(false),
    /**
     * Provenance of a thread created by forking another one at a chosen
     * message. `forkedFromMessageId` is the "this thread is a fork"
     * discriminator and deliberately carries no foreign key: edit and replay
     * truncation delete messages, and provenance must neither dangle-block
     * that delete nor vanish with it (same reasoning as `recapMessageId`).
     * `parentThreadId` goes null when the source thread is deleted, so a null
     * parent beside a non-null boundary message reads as "forked from a thread
     * that no longer exists".
     */
    parentThreadId: safeUuid<"chatThread">("parent_thread_id").references(
      (): AnyPgColumn => chatThreads.id,
      { onDelete: "set null" },
    ),
    forkedFromMessageId: safeUuid<"chatMessage">("forked_from_message_id"),
    /**
     * Durable queue address for incremental thread compaction. Null means no
     * compaction work is pending. A send whose history window crosses the
     * compaction trigger stamps `now()`; the compactor claims a due thread by
     * overwriting this with its lease expiry and settles it with a
     * compare-and-set on that token, so a send that wakes the thread while a
     * run is in flight is never erased.
     */
    compactionScheduledAt: timestamptz("compaction_scheduled_at"),
    /**
     * When the compactor last attempted this thread. Failed attempts stay
     * eligible but rotate behind untouched work, so one permanently failing
     * thread cannot monopolize a batch.
     */
    compactionAttemptedAt: timestamptz("compaction_attempted_at"),
    /**
     * Consecutive failed compaction attempts, reset by any run that makes
     * progress. Drives the capped exponential backoff the failed settlement
     * writes into `compactionScheduledAt`, so a thread that cannot be compacted
     * at all stops costing a claim slot and a provider call every tick.
     */
    compactionAttempts: p.integer("compaction_attempts").notNull().default(0),
    /**
     * Bumped whenever an edit, replay, or delete invalidates the checkpoint
     * chain. The compactor reads it with the delta and compares it again under
     * the thread lock, so a message change that commits mid-run is detected
     * before the summary is written.
     *
     * Needed because the compactor's other guard compares active checkpoint
     * ids, which is vacuous on a thread that has none: invalidation marks no
     * row stale, both sides read null, and a summary built from superseded
     * content would be accepted and its cursor advanced past the corrected row.
     */
    compactionEpoch: p.integer("compaction_epoch").notNull().default(0),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // RESTRICT mirrors the single-column workspace reference: a global thread
    // (workspace_id NULL) is exempt under MATCH SIMPLE, and matter deletion
    // removes threads explicitly before it removes the workspace.
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "chat_threads_workspace_organization_fk",
      })
      .onDelete("restrict"),
    p
      .index("chat_threads_workspace_user_idx")
      .on(table.workspaceId, table.userId),
    p
      .index("chat_threads_organization_user_idx")
      .on(table.organizationId, table.userId),
    p
      .index("chat_threads_org_user_updated_id_idx")
      .on(table.organizationId, table.userId, table.updatedAt, table.id),
    p
      .index("chat_threads_context_matter_ids_idx")
      .using("gin", table.contextMatterIds),
    p
      .index("chat_threads_data_workspace_ids_idx")
      .using("gin", table.dataWorkspaceIds),
    p.index("chat_threads_user_updated_idx").on(table.userId, table.updatedAt),
    // Serves the parent self-reference's ON DELETE SET NULL scan: without it
    // every thread delete reads all of chat_threads. Partial because only a
    // fork carries a parent.
    p
      .index("chat_threads_parent_thread_idx")
      .on(table.parentThreadId)
      .where(isNotNull(table.parentThreadId)),
    // Serves the compactor's claim seek: due threads oldest-first, with
    // never-attempted work ahead of previously failed work.
    p
      .index("chat_threads_compaction_due_idx")
      .on(
        table.compactionScheduledAt,
        sql`${table.compactionAttemptedAt} ASC NULLS FIRST`,
        table.id,
      )
      .where(sql`${table.compactionScheduledAt} IS NOT NULL`),
    p.check(
      "chat_threads_reasoning_effort_selection_check",
      sql`${table.chatReasoningEffort} IS NULL OR (${table.chatModel} IS NOT NULL AND ${table.chatReasoningEffort} IN (${sql.join(REASONING_EFFORT_SQL_VALUES, sql`, `)}))`,
    ),
    ...chatThreadPolicies(),
  ],
);

export const chatMessages = p.pgTable(
  "chat_messages",
  {
    id: pUuid<"chatMessage">().primaryKey(),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, {
        onDelete: "cascade",
      }),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      {
        onDelete: "restrict",
      },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: p.varchar({ length: 16 }).notNull().$type<ChatMessageRole>(),
    content: jsonb().notNull().$type<PersistedChatMessageContent>(),
    // Captured when content is written. Compactions spanning an opted-out
    // message remain permanently ineligible for later memory extraction,
    // even if the deployment feature is enabled again before compaction.
    memoryExtractionEligible: p
      .boolean("memory_extraction_eligible")
      .notNull()
      // Fail closed for any future writer that does not make an explicit
      // eligibility decision. Existing rows are backfilled as eligible by the
      // migration because they predate the deployment opt-out boundary.
      .default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("chat_messages_thread_created_idx")
      .on(table.threadId, table.createdAt),
    p
      .index("chat_messages_user_workspace_created_idx")
      .on(table.userId, table.workspaceId, table.createdAt),
    // Prepared online for a later additive composite FK that will make the
    // message/turn same-thread link declarative without locking chat history.
    p.uniqueIndex("chat_messages_id_thread_uidx").on(table.id, table.threadId),
    ...chatMessagePolicies(),
  ],
);

/**
 * Durable ownership and settlement for one assistant turn. Message content
 * remains in chat_messages; every terminal success or failure owns the
 * assistant message that reload hydration renders.
 */
export const chatTurns = p.pgTable(
  "chat_turns",
  {
    id: pUuid<"chatTurn">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      { onDelete: "restrict" },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userMessageId: safeUuid<"chatMessage">("user_message_id").notNull(),
    assistantMessageId: safeUuid<"chatMessage">("assistant_message_id"),
    status: p.text({ enum: CHAT_TURN_STATUSES }).notNull().default("accepted"),
    executionId: p.uuid("execution_id"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    interactionType: p.text("interaction_type", {
      enum: CHAT_TURN_INTERACTION_TYPES,
    }),
    interactionToolCallId: p.text("interaction_tool_call_id"),
    failureCode: p.text("failure_code", { enum: CHAT_TURN_FAILURE_CODES }),
    failureRetryable: p.boolean("failure_retryable"),
    cancellationReason: p.text("cancellation_reason", {
      enum: CHAT_TURN_CANCELLATION_REASONS,
    }),
    interruptionReason: p.text("interruption_reason", {
      enum: CHAT_TURN_INTERRUPTION_REASONS,
    }),
    settledAt: timestamptz("settled_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .foreignKey({
        name: "chat_turns_user_message_thread_fk",
        columns: [table.userMessageId, table.threadId],
        foreignColumns: [chatMessages.id, chatMessages.threadId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "chat_turns_assistant_message_thread_fk",
        columns: [table.assistantMessageId, table.threadId],
        foreignColumns: [chatMessages.id, chatMessages.threadId],
      })
      .onDelete("cascade"),
    // RESTRICT mirrors the single-column workspace reference; a global turn
    // (workspace_id NULL) is exempt under MATCH SIMPLE.
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "chat_turns_workspace_organization_fk",
      })
      .onDelete("restrict"),
    p.check(
      "chat_turns_status_values_check",
      sql`${table.status} IN (${sql.join(CHAT_TURN_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "chat_turns_interaction_values_check",
      sql`${table.interactionType} IS NULL OR ${table.interactionType} IN (${sql.join(CHAT_TURN_INTERACTION_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "chat_turns_failure_code_values_check",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} IN (${sql.join(CHAT_TURN_FAILURE_CODE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "chat_turns_cancellation_reason_values_check",
      sql`${table.cancellationReason} IS NULL OR ${table.cancellationReason} IN (${sql.join(CHAT_TURN_CANCELLATION_REASON_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "chat_turns_interruption_reason_values_check",
      sql`${table.interruptionReason} IS NULL OR ${table.interruptionReason} IN (${sql.join(CHAT_TURN_INTERRUPTION_REASON_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "chat_turns_state_payload_check",
      sql`CASE ${table.status}
        WHEN 'accepted' THEN
          ${table.leaseExpiresAt} IS NOT NULL AND
          ${table.executionId} IS NULL AND
          ${table.assistantMessageId} IS NULL AND
          ${table.interactionType} IS NULL AND
          ${table.interactionToolCallId} IS NULL AND
          ${table.failureCode} IS NULL AND
          ${table.failureRetryable} IS NULL AND
          ${table.cancellationReason} IS NULL AND
          ${table.interruptionReason} IS NULL AND
          ${table.settledAt} IS NULL
        WHEN 'running' THEN
          ${table.leaseExpiresAt} IS NOT NULL AND
          ${table.executionId} IS NOT NULL AND
          ${table.assistantMessageId} IS NULL AND
          ${table.interactionType} IS NULL AND
          ${table.interactionToolCallId} IS NULL AND
          ${table.failureCode} IS NULL AND
          ${table.failureRetryable} IS NULL AND
          ${table.cancellationReason} IS NULL AND
          ${table.interruptionReason} IS NULL AND
          ${table.settledAt} IS NULL
        WHEN 'awaiting-user' THEN
          ${table.leaseExpiresAt} IS NULL AND
          ${table.executionId} IS NULL AND
          ${table.assistantMessageId} IS NOT NULL AND
          ${table.interactionType} IS NOT NULL AND
          ${table.interactionToolCallId} IS NOT NULL AND
          ${table.failureCode} IS NULL AND
          ${table.failureRetryable} IS NULL AND
          ${table.cancellationReason} IS NULL AND
          ${table.interruptionReason} IS NULL AND
          ${table.settledAt} IS NULL
        WHEN 'completed' THEN
          ${table.leaseExpiresAt} IS NULL AND
          ${table.executionId} IS NULL AND
          ${table.assistantMessageId} IS NOT NULL AND
          ${table.interactionType} IS NULL AND
          ${table.interactionToolCallId} IS NULL AND
          ${table.failureCode} IS NULL AND
          ${table.failureRetryable} IS NULL AND
          ${table.cancellationReason} IS NULL AND
          ${table.interruptionReason} IS NULL AND
          ${table.settledAt} IS NOT NULL
        WHEN 'failed' THEN
          ${table.leaseExpiresAt} IS NULL AND
          ${table.executionId} IS NULL AND
          ${table.assistantMessageId} IS NOT NULL AND
          ${table.interactionType} IS NULL AND
          ${table.interactionToolCallId} IS NULL AND
          ${table.failureCode} IS NOT NULL AND
          ${table.failureRetryable} IS NOT NULL AND
          ${table.cancellationReason} IS NULL AND
          ${table.interruptionReason} IS NULL AND
          ${table.settledAt} IS NOT NULL
        WHEN 'cancelled' THEN
          ${table.leaseExpiresAt} IS NULL AND
          ${table.executionId} IS NULL AND
          ${table.assistantMessageId} IS NULL AND
          ${table.interactionType} IS NULL AND
          ${table.interactionToolCallId} IS NULL AND
          ${table.failureCode} IS NULL AND
          ${table.failureRetryable} IS NULL AND
          ${table.cancellationReason} IS NOT NULL AND
          ${table.interruptionReason} IS NULL AND
          ${table.settledAt} IS NOT NULL
        WHEN 'interrupted' THEN
          ${table.leaseExpiresAt} IS NULL AND
          ${table.executionId} IS NULL AND
          ${table.assistantMessageId} IS NULL AND
          ${table.interactionType} IS NULL AND
          ${table.interactionToolCallId} IS NULL AND
          ${table.failureCode} IS NULL AND
          ${table.failureRetryable} IS NULL AND
          ${table.cancellationReason} IS NULL AND
          ${table.interruptionReason} IS NOT NULL AND
          ${table.settledAt} IS NOT NULL
        ELSE false
      END`,
    ),
    p.check(
      "chat_turns_lease_after_created_check",
      sql`${table.leaseExpiresAt} IS NULL OR ${table.leaseExpiresAt} > ${table.createdAt}`,
    ),
    p.check(
      "chat_turns_settled_after_created_check",
      sql`${table.settledAt} IS NULL OR ${table.settledAt} >= ${table.createdAt}`,
    ),
    p.index("chat_turns_thread_id_idx").on(table.threadId),
    p
      .uniqueIndex("chat_turns_active_thread_uidx")
      .on(table.threadId)
      .where(sql`${table.status} IN ('accepted', 'running', 'awaiting-user')`),
    p
      .index("chat_turns_org_user_thread_created_idx")
      .on(
        table.organizationId,
        table.userId,
        table.threadId,
        table.createdAt,
        table.id,
      ),
    p
      .index("chat_turns_org_user_message_created_idx")
      .on(table.organizationId, table.userMessageId, table.createdAt, table.id),
    p
      .index("chat_turns_org_active_lease_idx")
      .on(table.organizationId, table.status, table.leaseExpiresAt, table.id)
      .where(sql`${table.status} IN ('accepted', 'running')`),
    ...chatTurnPolicies(),
  ],
);

export const fileChatThreads = p.pgTable(
  "file_chat_threads",
  {
    id: pUuid<"fileChatThread">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    fieldId: safeUuid<"field">("field_id").notNull(),
    chatThreadId: safeUuid<"chatThread">("chat_thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("file_chat_threads_scope_uidx")
      .on(
        table.organizationId,
        table.workspaceId,
        table.userId,
        table.entityId,
        table.fieldId,
      ),
    p
      .uniqueIndex("file_chat_threads_chat_thread_id_uidx")
      .on(table.chatThreadId),
    p
      .index("file_chat_threads_workspace_entity_field_idx")
      .on(table.workspaceId, table.entityId, table.fieldId),
    p
      .foreignKey({
        columns: [table.workspaceId],
        foreignColumns: [workspaces.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "file_chat_threads_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "file_chat_threads_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.fieldId, table.workspaceId],
        foreignColumns: [fields.id, fields.workspaceId],
        name: "file_chat_threads_field_workspace_fk",
      })
      .onDelete("cascade"),
    ...fileChatThreadPolicies(),
  ],
);

/**
 * Per-user mapping of an org-scoped template to its latest chat
 * thread, so reopening a template in the Template Studio resumes
 * the conversation. "New chat" repoints `chatThreadId` at a fresh
 * thread; older threads stay reachable from the chat history list.
 */
export const templateChatThreads = p.pgTable(
  "template_chat_threads",
  {
    id: pUuid<"templateChatThread">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    templateId: safeUuid<"template">("template_id").notNull(),
    chatThreadId: safeUuid<"chatThread">("chat_thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("template_chat_threads_scope_uidx")
      .on(table.organizationId, table.userId, table.templateId),
    p
      .uniqueIndex("template_chat_threads_chat_thread_id_uidx")
      .on(table.chatThreadId),
    p
      .foreignKey({
        columns: [table.templateId, table.organizationId],
        foreignColumns: [templates.id, templates.organizationId],
        name: "template_chat_threads_template_organization_fk",
      })
      .onDelete("cascade"),
    ...templateChatThreadPolicies(),
  ],
);

export const chatThreadSearchDocuments = p.pgTable(
  "chat_thread_search_documents",
  {
    threadId: safeUuid<"chatThread">("thread_id")
      .primaryKey()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    previewGeneration: p.uuid("preview_generation"),
    tsv: tsvector(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("chat_thread_search_docs_tsv_idx").using("gin", table.tsv),
    ...chatThreadSearchDocumentPolicies(),
  ],
);

export const chatThreadSearchPreviewPassages = p.pgTable(
  "chat_thread_search_preview_passages",
  {
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreadSearchDocuments.threadId, {
        onDelete: "cascade",
      }),
    generation: p.uuid().notNull(),
    ordinal: p.integer().notNull(),
    content: p.text().notNull(),
    tsv: tsvector().notNull(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.threadId, table.generation, table.ordinal],
      name: "chat_thread_search_preview_passages_pk",
    }),
    p
      .index("chat_thread_preview_passages_lookup_idx")
      .on(table.threadId, table.generation, table.ordinal),
    p.index("chat_thread_preview_passages_tsv_idx").using("gin", table.tsv),
    ...chatThreadPreviewPassagePolicies(),
  ],
);

export const chatMessageSearchDocuments = p.pgTable(
  "chat_message_search_documents",
  {
    messageId: safeUuid<"chatMessage">("message_id")
      .primaryKey()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: p.varchar({ length: 16 }).notNull().$type<ChatMessageRole>(),
    searchableText: p.text("searchable_text").notNull().default(""),
    tsv: tsvector(),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("chat_message_search_docs_tsv_idx").using("gin", table.tsv),
    p
      .index("chat_message_search_docs_thread_created_idx")
      .on(table.threadId, table.createdAt, table.messageId),
    ...chatMessageSearchDocumentPolicies(),
  ],
);

export const chatThreadCompactions = p.pgTable(
  "chat_thread_compactions",
  {
    id: pUuid<"chatThreadCompaction">().primaryKey(),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    status: p
      .varchar({ length: 16 })
      .$type<"active" | "stale">()
      .notNull()
      .default("active"),
    summary: jsonb().$type<ChatCompactionSummary>().notNull(),
    summaryMarkdown: p.text("summary_markdown").notNull(),
    firstSummarizedMessageId: safeUuid<"chatMessage">(
      "first_summarized_message_id",
    ).notNull(),
    lastSummarizedMessageId: safeUuid<"chatMessage">(
      "last_summarized_message_id",
    ).notNull(),
    firstKeptMessageId: safeUuid<"chatMessage">(
      "first_kept_message_id",
    ).notNull(),
    summarizedMessageCount: p.integer("summarized_message_count").notNull(),
    /**
     * Encoded `(created_at, id)` keyset cursor for the last message this
     * checkpoint chain summarized. Every compactor run reads only the bounded
     * delta after it, so no run rereads lifetime history. Null on rows written
     * before the cursor landed; such a chain resumes from the start of the
     * thread and re-anchors on its next run.
     */
    deltaCursor: p.text("delta_cursor"),
    /**
     * Messages summarized by the whole checkpoint chain, not just this run.
     * `summarizedMessageCount` deliberately stays per-run so the memory
     * extractor's `[firstSummarized..lastSummarized]` transcript range remains
     * bounded.
     */
    totalSummarizedMessageCount: p
      .integer("total_summarized_message_count")
      .notNull()
      .default(0),
    totalTokens: p.integer("total_tokens").notNull(),
    preservedTokens: p.integer("preserved_tokens").notNull(),
    promptVersion: p.smallint("prompt_version").notNull(),
    modelProvider: p.text("model_provider"),
    modelId: p.text("model_id"),
    /**
     * Whether this summary may be mined for AI memory, and when not, why.
     * Recorded per segment and inherited along the chain, because a cumulative
     * summary cannot be re-derived from the messages it replaced. See
     * `ChatCompactionMemoryEligibility` for the values and their monotonicity.
     */
    memoryEligibility: p
      .varchar("memory_eligibility", { length: 20 })
      .$type<ChatCompactionMemoryEligibility>()
      .notNull()
      .default("unknown"),
    // Set by the memory extractor once it has proposed memories from
    // this compaction, so the background job stays idempotent.
    memoryExtractedAt: timestamptz("memory_extracted_at"),
    // Failed attempts stay eligible, but rotate behind untouched work so a
    // permanently bad compaction cannot monopolize its tenant's queue slice.
    memoryExtractionAttemptedAt: timestamptz("memory_extraction_attempted_at"),
    // Stamped from the owning thread by a database trigger on insert. Keeping
    // the tenant on the work item lets the extractor seek directly into one
    // organization's bounded queue slice instead of ranking every tenant's
    // pending compactions globally.
    memoryExtractionOrganizationId: safeOrganizationId(
      "memory_extraction_organization_id",
    ),
    // Copies organization_settings.memory_extraction_enabled_at only when
    // extraction consent is active at insert time. Consent generations are
    // part of the queue address, so re-enabling never scans an older window.
    memoryExtractionConsentAt: timestamptz("memory_extraction_consent_at"),
    // Snapshot of the thread's validated matter-data scope when this
    // compaction was created. Extraction must never read the thread's later,
    // mutable scope when deciding where the checkpoint's facts may surface.
    memoryExtractionDataWorkspaceIds: safeWorkspaceId(
      "memory_extraction_data_workspace_ids",
    )
      .array()
      .notNull()
      .default([]),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    // The three message references are named explicitly: drizzle's generated
    // names exceed PostgreSQL's 63-byte identifier limit and were silently
    // truncated in the catalog until 20260813110000 renamed them.
    p
      .foreignKey({
        columns: [table.firstSummarizedMessageId],
        foreignColumns: [chatMessages.id],
        name: "chat_thread_compactions_first_summarized_message_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.lastSummarizedMessageId],
        foreignColumns: [chatMessages.id],
        name: "chat_thread_compactions_last_summarized_message_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.firstKeptMessageId],
        foreignColumns: [chatMessages.id],
        name: "chat_thread_compactions_first_kept_message_fk",
      })
      .onDelete("cascade"),
    // Read off CHAT_COMPACTION_MEMORY_ELIGIBILITIES rather than re-listed: a
    // new eligibility value must reach the constraint and the column together,
    // and the extractability map beside the const is already total over it.
    p.check(
      "chat_thread_compactions_memory_eligibility_check",
      sql`${table.memoryEligibility} IN (${sql.join(
        CHAT_COMPACTION_MEMORY_ELIGIBILITY_SQL_VALUES,
        sql`, `,
      )})`,
    ),
    p
      .uniqueIndex("chat_thread_compactions_active_thread_uidx")
      .on(table.threadId)
      .where(sql`status = 'active'`),
    p
      .index("chat_thread_compactions_thread_status_created_idx")
      .on(table.threadId, table.status, table.createdAt),
    p
      .index("chat_thread_compactions_memory_data_workspace_ids_idx")
      .using("gin", table.memoryExtractionDataWorkspaceIds),
    p
      .foreignKey({
        name: "chat_compactions_memory_extraction_org_fk",
        columns: [table.memoryExtractionOrganizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .index("chat_thread_compactions_memory_unmined_org_idx")
      .on(
        table.memoryExtractionOrganizationId,
        table.memoryExtractionConsentAt,
        sql`${table.memoryExtractionAttemptedAt} ASC NULLS FIRST`,
        table.createdAt,
        table.id,
      )
      .where(
        sql`${table.memoryExtractionOrganizationId} IS NOT NULL AND ${table.memoryExtractionConsentAt} IS NOT NULL AND ${table.memoryExtractedAt} IS NULL AND ${table.status} = 'active'`,
      ),
    ...chatThreadCompactionPolicies(),
  ],
);

/** Whose memory a row is: the firm, one lawyer, or one matter. */
const AI_MEMORY_SCOPES = ["organization", "user", "workspace"] as const;

/** What a memory asserts; drives which scopes may hold it. */
const AI_MEMORY_KINDS = [
  "preference",
  "instruction",
  "fact",
  "decision",
  "relationship",
] as const;

type AiMemoryKind = (typeof AI_MEMORY_KINDS)[number];

/**
 * Kinds that carry no matter-specific content, so any scope may hold them.
 * Every other kind is matter-derived and belongs to a workspace.
 */
const AI_MEMORY_SCOPE_FREE_KINDS = [
  "preference",
  "instruction",
] as const satisfies readonly AiMemoryKind[];

/** Curator lifecycle: suggested -> active -> stale -> archived. */
const AI_MEMORY_STATUSES = [
  "suggested",
  "active",
  "stale",
  "archived",
] as const;

/** Who wrote the memory: an explicit user or tool write, or the extractor. */
const AI_MEMORY_SOURCES = ["user", "tool", "extracted"] as const;

const AI_MEMORY_KIND_SQL_VALUES = AI_MEMORY_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);

const AI_MEMORY_SCOPE_FREE_KIND_SQL_VALUES = AI_MEMORY_SCOPE_FREE_KINDS.map(
  (kind) => sql.raw(`'${kind}'`),
);

const AI_MEMORY_STATUS_SQL_VALUES = AI_MEMORY_STATUSES.map((status) =>
  sql.raw(`'${status}'`),
);

const AI_MEMORY_SOURCE_SQL_VALUES = AI_MEMORY_SOURCES.map((source) =>
  sql.raw(`'${source}'`),
);

/**
 * Persistent AI memory: typed facts and preferences the assistant
 * recalls across sessions, scoped to the firm (organization), the
 * lawyer (user), or a matter (workspace). Read precedence is matter
 * > user > firm. Users may archive, restore, or permanently erase memories;
 * deleting a source matter erases every memory derived from it. Memories are
 * tenant-isolated via RLS; matter-derived content is additionally gated by
 * `sourceDataWorkspaceIds` so it cannot cross matters.
 */
export const aiMemories = p.pgTable(
  "ai_memories",
  {
    id: pUuid<"aiMemory">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scope: p.text("scope", { enum: AI_MEMORY_SCOPES }).notNull(),
    userId: p
      .text("user_id")
      .$type<SafeId<"user">>()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id"),
    kind: p.text("kind", { enum: AI_MEMORY_KINDS }).notNull(),
    content: p.text("content").notNull(),
    // SHA-256 over canonical scope, owner, kind, sanitized content, and
    // provenance. The org-led unique index makes every write path idempotent
    // under concurrent API/tool/extractor attempts.
    dedupKey: p.varchar("dedup_key", { length: 64 }).notNull(),
    language: p.varchar("language", { length: 10 }),
    // Workspaces whose content this memory was derived from. Gates RLS
    // reads (subset of session-accessible workspaces). Empty = not
    // matter-derived (e.g. an explicit user preference).
    sourceDataWorkspaceIds: safeWorkspaceId("source_data_workspace_ids")
      .array()
      .notNull()
      .default([]),
    status: p
      .text("status", { enum: AI_MEMORY_STATUSES })
      .notNull()
      .default("active"),
    pinned: p.boolean("pinned").notNull().default(false),
    source: p.text("source", { enum: AI_MEMORY_SOURCES }).notNull(),
    sourceMessageId: safeUuid<"chatMessage">("source_message_id").references(
      () => chatMessages.id,
      { onDelete: "set null" },
    ),
    confidence: p.doublePrecision("confidence"),
    // Initiating user for explicit writes and extracted suggestions. May become
    // null after user deletion; lifecycle audit events use a system actor.
    createdBy: p
      .text("created_by")
      .$type<SafeId<"user">>()
      .references(() => user.id, { onDelete: "set null" }),
    supersededById: safeUuid<"aiMemory">("superseded_by_id").references(
      (): AnyPgColumn => aiMemories.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Drives the curator lifecycle (active -> stale -> archived).
    lastUsedAt: timestamptz("last_used_at").notNull().defaultNow(),
    archivedAt: timestamptz("archived_at"),
  },
  (table) => [
    p
      .index("ai_memories_org_scope_status_idx")
      .on(table.organizationId, table.scope, table.status),
    p
      .uniqueIndex("ai_memories_org_dedup_uidx")
      .on(table.organizationId, table.dedupKey),
    p
      .index("ai_memories_org_status_created_idx")
      .on(table.organizationId, table.status, table.createdAt, table.id),
    p
      .index("ai_memories_user_status_idx")
      .on(table.userId, table.status)
      .where(isNotNull(table.userId)),
    p
      .index("ai_memories_created_by_status_idx")
      .on(table.createdBy, table.status)
      .where(isNotNull(table.createdBy)),
    p
      .index("ai_memories_workspace_status_idx")
      .on(table.workspaceId, table.status)
      .where(isNotNull(table.workspaceId)),
    p
      .index("ai_memories_source_message_idx")
      .on(table.sourceMessageId)
      .where(isNotNull(table.sourceMessageId)),
    p
      .index("ai_memories_source_workspaces_gin_idx")
      .using("gin", table.sourceDataWorkspaceIds),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "ai_memories_workspace_org_fkey",
      })
      .onDelete("cascade"),
    p
      .index("ai_memories_active_lifecycle_idx")
      .on(table.lastUsedAt)
      .where(sql`${table.status} = 'active' AND ${table.pinned} = false`),
    p
      .index("ai_memories_stale_lifecycle_idx")
      .on(table.lastUsedAt)
      .where(sql`${table.status} = 'stale' AND ${table.pinned} = false`),
    p
      .index("ai_memories_suggested_lifecycle_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'suggested' AND ${table.pinned} = false`),
    // Scope/id integrity: exactly the ids for the scope, nothing else.
    p.check(
      "ai_memories_scope_ids_check",
      sql`(
        (scope = 'organization' AND user_id IS NULL AND workspace_id IS NULL)
        OR (scope = 'user' AND user_id IS NOT NULL AND workspace_id IS NULL)
        OR (scope = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL)
      )`,
    ),
    // Matter-specific kinds may only live at workspace scope, so a
    // matter fact can never be stored as user/firm memory.
    p.check(
      "ai_memories_kind_scope_check",
      sql`(kind IN (${sql.join(AI_MEMORY_SCOPE_FREE_KIND_SQL_VALUES, sql`, `)}) OR scope = 'workspace')`,
    ),
    p.check(
      "ai_memories_kind_check",
      sql`kind IN (${sql.join(AI_MEMORY_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "ai_memories_status_check",
      sql`status IN (${sql.join(AI_MEMORY_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "ai_memories_source_check",
      sql`source IN (${sql.join(AI_MEMORY_SOURCE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "ai_memories_confidence_check",
      sql`confidence IS NULL OR (source = 'extracted' AND confidence >= 0 AND confidence <= 1)`,
    ),
    p.check("ai_memories_dedup_key_check", sql`dedup_key ~ '^[0-9a-f]{64}$'`),
    ...aiMemoryPolicies(),
  ],
);

// -- MCP Connectors --

export const MCP_CONNECTOR_AUTH_TYPES = ["none", "bearer", "oauth2"] as const;
export type McpConnectorAuthType = (typeof MCP_CONNECTOR_AUTH_TYPES)[number];

export const MCP_CONNECTION_STATUSES = [
  "connected",
  "needs_reauth",
  "revoked",
] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

export type McpOAuthRegistrationResponse = Record<string, unknown>;
