import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import { renderChatMessagesForCompaction } from "@/api/handlers/chat/compaction";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type {
  ChatMessage,
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";
import { buildSearchTsQuery } from "@/api/lib/search/query";

const CHAT_HISTORY_HEADLINE_CONFIG =
  "StartSel=<hit>, StopSel=</hit>, MaxWords=40, MinWords=10, ShortWord=3";

export const SEARCH_CHAT_HISTORY_TOOL_NAME = "search-chat-history";
export const EXPAND_CHAT_HISTORY_TOOL_NAME = "expand-chat-history";

const searchChatHistoryInputSchema = v.strictObject({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
    v.description("Text to search in earlier messages in this chat thread."),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(LIMITS.chatHistorySearchPageSizeMax),
      v.description("Maximum number of matching messages to return."),
    ),
    LIMITS.chatHistorySearchPageSizeDefault,
  ),
});

const expandChatHistoryInputSchema = v.strictObject({
  messageId: v.pipe(
    v.string(),
    v.uuid(),
    v.description(
      "Message ID returned by search-chat-history, search-past-chats, or search-all-past-chats.",
    ),
  ),
  before: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(LIMITS.chatHistoryExpansionSideMax),
      v.description("Messages to include before the target message."),
    ),
    2,
  ),
  after: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(LIMITS.chatHistoryExpansionSideMax),
      v.description("Messages to include after the target message."),
    ),
    2,
  ),
});

const searchChatHistoryOutputSchema = v.strictObject({
  query: v.string(),
  results: v.array(
    v.strictObject({
      messageId: v.string(),
      role: v.string(),
      excerpt: v.string(),
      createdAt: v.string(),
    }),
  ),
});

const expandChatHistoryOutputSchema = v.strictObject({
  targetMessageId: v.string(),
  messages: v.array(
    v.strictObject({
      messageId: v.string(),
      role: v.string(),
      createdAt: v.string(),
      content: v.string(),
    }),
  ),
});

type CreateChatHistoryToolsProps = {
  excludedMessageIds?: readonly SafeId<"chatMessage">[] | undefined;
  organizationId: SafeId<"organization">;
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

type ChatHistorySearchRow = {
  createdAt: Date;
  excerpt: string;
  messageId: SafeId<"chatMessage">;
  role: ChatMessageRole;
};

type ChatHistoryExpansionRow = {
  content: PersistedChatMessageContent;
  createdAt: Date;
  dataWorkspaceIds: SafeId<"workspace">[];
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
  threadWorkspaceId: SafeId<"workspace"> | null;
};

export const createChatHistoryTools = ({
  excludedMessageIds = [],
  organizationId,
  refRegistry,
  safeDb,
  threadId,
  userId,
}: CreateChatHistoryToolsProps) => {
  const excludedMessageIdSet = new Set<string>(excludedMessageIds);
  const excludedMessageIdValues = excludedMessageIds.map((id) => sql`${id}`);
  const excludeMessageSql = (messageIdSql: SQL) =>
    excludedMessageIdValues.length === 0
      ? sql``
      : sql`AND ${messageIdSql} NOT IN (${sql.join(
          excludedMessageIdValues,
          sql`, `,
        )})`;

  return {
    [SEARCH_CHAT_HISTORY_TOOL_NAME]: toolDefinition({
      name: SEARCH_CHAT_HISTORY_TOOL_NAME,
      description:
        "Search earlier persisted messages in this same chat thread. Use this when compacted context may omit a detail, prior instruction, cited source, or unresolved task. Follow up with expand-chat-history when exact surrounding context matters.",
      inputSchema: toTanStackToolSchema(searchChatHistoryInputSchema),
      outputSchema: toTanStackToolSchema(searchChatHistoryOutputSchema),
    }).server(async ({ query, limit }) => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new ChatToolError({
          kind: "invalid-input",
          message: "Chat history search query must not be empty.",
        });
      }

      const tsQuery = buildSearchTsQuery(normalizedQuery);
      const result = await safeDb((tx) =>
        tx.execute<ChatHistorySearchRow>(sql`
        SELECT
          message_id AS "messageId",
          role,
          ts_headline(
            'simple',
            left(searchable_text, 2000),
            ${tsQuery},
            ${CHAT_HISTORY_HEADLINE_CONFIG}
          ) AS excerpt,
          created_at AS "createdAt"
        FROM chat_message_search_documents
        WHERE thread_id = ${threadId}
          AND tsv @@ ${tsQuery}
          ${excludeMessageSql(sql`message_id`)}
        ORDER BY ts_rank(tsv, ${tsQuery}) DESC, created_at DESC, message_id DESC
        LIMIT ${limit}
      `),
      );

      if (Result.isError(result)) {
        throw new ChatToolError({
          kind: "server-defect",
          message: "Failed to search chat history.",
          cause: result.error,
        });
      }

      return {
        query: normalizedQuery,
        results: result.value.map((row) => ({
          messageId: row.messageId,
          role: row.role,
          // Persisted text carries stable mention hrefs with raw tenant
          // UUIDs; hand-written history tools bypass the registry adapter's
          // hydration, so rewrite them into chat refs here before the text
          // reaches the model.
          excerpt: refRegistry.hydrateAssistantTextRefs(row.excerpt),
          createdAt: row.createdAt.toISOString(),
        })),
      };
    }),
    [EXPAND_CHAT_HISTORY_TOOL_NAME]: toolDefinition({
      name: EXPAND_CHAT_HISTORY_TOOL_NAME,
      description:
        "Expand one chat-history or past-chat search result into a small transcript window from the chat it belongs to. Use only with a messageId returned by search-chat-history, search-past-chats, or search-all-past-chats.",
      inputSchema: toTanStackToolSchema(expandChatHistoryInputSchema),
      outputSchema: toTanStackToolSchema(expandChatHistoryOutputSchema),
    }).server(async ({ messageId, before, after }) => {
      if (excludedMessageIdSet.has(messageId)) {
        return {
          targetMessageId: messageId,
          messages: [],
        };
      }

      const persistedMessageId = brandPersistedChatMessageId(messageId);
      const result = await safeDb((tx) =>
        tx.execute<ChatHistoryExpansionRow>(sql`
        WITH target AS (
          SELECT
            m.id,
            m.thread_id,
            m.created_at,
            t.workspace_id AS thread_workspace_id,
            t.data_workspace_ids
          FROM chat_messages m
          JOIN chat_threads t ON t.id = m.thread_id
          WHERE m.id = ${persistedMessageId}
            AND t.user_id = ${userId}
            AND t.organization_id = ${organizationId}
          LIMIT 1
        ),
        window_rows AS (
          (
            SELECT m.id, m.role, m.content, m.created_at
            FROM chat_messages m, target t
            WHERE m.thread_id = t.thread_id
              ${excludeMessageSql(sql`m.id`)}
              AND (m.created_at, m.id) < (t.created_at, t.id)
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ${before}
          )
          UNION ALL
          SELECT m.id, m.role, m.content, m.created_at
          FROM chat_messages m, target t
          WHERE m.id = t.id
            ${excludeMessageSql(sql`m.id`)}
          UNION ALL
          (
            SELECT m.id, m.role, m.content, m.created_at
            FROM chat_messages m, target t
            WHERE m.thread_id = t.thread_id
              ${excludeMessageSql(sql`m.id`)}
              AND (m.created_at, m.id) > (t.created_at, t.id)
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT ${after}
          )
        )
        SELECT
          w.id,
          w.role,
          w.content,
          w.created_at AS "createdAt",
          t.thread_workspace_id AS "threadWorkspaceId",
          t.data_workspace_ids AS "dataWorkspaceIds"
        FROM window_rows w, target t
        ORDER BY w.created_at ASC, w.id ASC
      `),
      );

      if (Result.isError(result)) {
        throw new ChatToolError({
          kind: "server-defect",
          message: "Failed to expand chat history.",
          cause: result.error,
        });
      }

      const target = result.value.at(0);
      if (target !== undefined) {
        // A past chat's matters fold into this thread's data scope, exactly
        // as in search-past-chats.
        if (target.threadWorkspaceId !== null) {
          refRegistry.toMatterRef(target.threadWorkspaceId);
        }
        for (const workspaceId of target.dataWorkspaceIds) {
          refRegistry.toMatterRef(workspaceId);
        }
      }

      return {
        targetMessageId: messageId,
        messages: result.value.map((row) => {
          const message = persistedRowToChatMessage(row);
          return {
            messageId: row.id,
            role: row.role,
            createdAt: row.createdAt.toISOString(),
            // Same rationale as the search excerpt: persisted mention hrefs
            // must re-enter the model as chat refs, not raw tenant UUIDs.
            content: refRegistry.hydrateAssistantTextRefs(
              renderChatMessagesForCompaction([message]),
            ),
          };
        }),
      };
    }),
  };
};

const persistedRowToChatMessage = (
  row: ChatHistoryExpansionRow,
): ChatMessage => ({
  id: row.id,
  role: row.role,
  parts: normalizePersistedChatMessageContent(row.content).parts,
});
