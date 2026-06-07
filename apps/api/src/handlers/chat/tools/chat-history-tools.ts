import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import { Result } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb } from "@/api/db";
import { renderChatMessagesForCompaction } from "@/api/handlers/chat/compaction";
import type {
  ChatMessage,
  ChatMessageContent,
  ChatMessageRole,
} from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
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
    v.description("Message ID returned by search-chat-history."),
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
  safeDb: SafeDb;
  threadId: SafeId<"chatThread">;
};

type ChatHistorySearchRow = {
  createdAt: Date;
  excerpt: string;
  messageId: SafeId<"chatMessage">;
  role: ChatMessageRole;
};

type ChatHistoryExpansionRow = {
  content: ChatMessageContent;
  createdAt: Date;
  id: SafeId<"chatMessage">;
  role: ChatMessageRole;
};

export const createChatHistoryTools = ({
  safeDb,
  threadId,
}: CreateChatHistoryToolsProps) => ({
  [SEARCH_CHAT_HISTORY_TOOL_NAME]: tool({
    description:
      "Search earlier persisted messages in this same chat thread. Use this when compacted context may omit a detail, prior instruction, cited source, or unresolved task. Follow up with expand-chat-history when exact surrounding context matters.",
    inputSchema: valibotSchema(searchChatHistoryInputSchema),
    outputSchema: valibotSchema(searchChatHistoryOutputSchema),
    execute: async ({ query, limit }) => {
      const normalizedQuery = query.trim();
      if (!normalizedQuery) {
        throw new ChatToolError({
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
          ORDER BY ts_rank(tsv, ${tsQuery}) DESC, created_at DESC, message_id DESC
          LIMIT ${limit}
        `),
      );

      if (Result.isError(result)) {
        throw new ChatToolError({
          message: "Failed to search chat history.",
          cause: result.error,
        });
      }

      return {
        query: normalizedQuery,
        results: result.value.map((row) => ({
          messageId: row.messageId,
          role: row.role,
          excerpt: row.excerpt,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  }),
  [EXPAND_CHAT_HISTORY_TOOL_NAME]: tool({
    description:
      "Expand one persisted chat-history search result into a small transcript window from this same thread. Use only with a messageId returned by search-chat-history.",
    inputSchema: valibotSchema(expandChatHistoryInputSchema),
    outputSchema: valibotSchema(expandChatHistoryOutputSchema),
    execute: async ({ messageId, before, after }) => {
      const persistedMessageId = brandPersistedChatMessageId(messageId);
      const result = await safeDb((tx) =>
        tx.execute<ChatHistoryExpansionRow>(sql`
          WITH target AS (
            SELECT id, created_at
            FROM chat_messages
            WHERE thread_id = ${threadId}
              AND id = ${persistedMessageId}
            LIMIT 1
          ),
          before_rows AS (
            SELECT m.id, m.role, m.content, m.created_at
            FROM chat_messages m, target t
            WHERE m.thread_id = ${threadId}
              AND (m.created_at, m.id) < (t.created_at, t.id)
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ${before}
          ),
          target_row AS (
            SELECT m.id, m.role, m.content, m.created_at
            FROM chat_messages m
            WHERE m.thread_id = ${threadId}
              AND m.id = ${persistedMessageId}
          ),
          after_rows AS (
            SELECT m.id, m.role, m.content, m.created_at
            FROM chat_messages m, target t
            WHERE m.thread_id = ${threadId}
              AND (m.created_at, m.id) > (t.created_at, t.id)
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT ${after}
          )
          SELECT id, role, content, created_at AS "createdAt"
          FROM (
            SELECT * FROM before_rows
            UNION ALL
            SELECT * FROM target_row
            UNION ALL
            SELECT * FROM after_rows
          ) history_rows
          ORDER BY created_at ASC, id ASC
        `),
      );

      if (Result.isError(result)) {
        throw new ChatToolError({
          message: "Failed to expand chat history.",
          cause: result.error,
        });
      }

      return {
        targetMessageId: messageId,
        messages: result.value.map((row) => {
          const message = persistedRowToChatMessage(row);
          return {
            messageId: row.id,
            role: row.role,
            createdAt: row.createdAt.toISOString(),
            content: renderChatMessagesForCompaction([message]),
          };
        }),
      };
    },
  }),
});

const persistedRowToChatMessage = (
  row: ChatHistoryExpansionRow,
): ChatMessage => ({
  id: row.id,
  role: row.role,
  parts: row.content.data,
});
