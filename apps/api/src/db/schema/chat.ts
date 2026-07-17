import {
  chatMessageSearchDocumentPolicies,
  chatMessagePolicies,
  chatThreadCompactionPolicies,
  chatThreadSearchDocumentPolicies,
  chatThreadPolicies,
  fileChatThreadPolicies,
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
} from "./common";
import type {
  ChatCompactionSummary,
  ChatMessageRole,
  PersistedChatMessageContent,
} from "./common";
import { workspaces } from "./contacts";
import { entities, fields } from "./entities";
import { templates } from "./templates";

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
    title: p.varchar({ length: 255 }).notNull(),
    titleSource: p
      .varchar("title_source", { length: 4 })
      .$type<"ai" | "user">()
      .notNull()
      .default("user"),
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
    recapGeneratedAt: p.timestamp("recap_generated_at"),
    usedAnonymization: p.boolean("used_anonymization").notNull().default(false),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("chat_threads_workspace_user_idx")
      .on(table.workspaceId, table.userId),
    p
      .index("chat_threads_organization_user_idx")
      .on(table.organizationId, table.userId),
    p
      .index("chat_threads_org_user_updated_id_idx")
      .on(table.organizationId, table.userId, table.updatedAt, table.id),
    p.index("chat_threads_user_updated_idx").on(table.userId, table.updatedAt),
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("chat_messages_thread_created_idx")
      .on(table.threadId, table.createdAt),
    p
      .index("chat_messages_user_workspace_created_idx")
      .on(table.userId, table.workspaceId, table.createdAt),
    ...chatMessagePolicies(),
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
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
    tsv: tsvector(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("chat_thread_search_docs_tsv_idx").using("gin", table.tsv),
    ...chatThreadSearchDocumentPolicies(),
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
    createdAt: p.timestamp("created_at").notNull(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
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
    )
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    lastSummarizedMessageId: safeUuid<"chatMessage">(
      "last_summarized_message_id",
    )
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    firstKeptMessageId: safeUuid<"chatMessage">("first_kept_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    summarizedMessageCount: p.integer("summarized_message_count").notNull(),
    totalTokens: p.integer("total_tokens").notNull(),
    preservedTokens: p.integer("preserved_tokens").notNull(),
    promptVersion: p.smallint("prompt_version").notNull(),
    modelProvider: p.text("model_provider"),
    modelId: p.text("model_id"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("chat_thread_compactions_active_thread_uidx")
      .on(table.threadId)
      .where(sql`status = 'active'`),
    p
      .index("chat_thread_compactions_thread_status_created_idx")
      .on(table.threadId, table.status, table.createdAt),
    ...chatThreadCompactionPolicies(),
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
