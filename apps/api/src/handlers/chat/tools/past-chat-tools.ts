import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatMessageRole } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { LIMITS } from "@/api/lib/limits";
import { buildSearchTsQuery } from "@/api/lib/search/query";
import { typedPgArray } from "@/api/lib/search/sql";

export const SEARCH_PAST_CHATS_TOOL_NAME = "search-past-chats";
export const SEARCH_ALL_PAST_CHATS_TOOL_NAME = "search-all-past-chats";

export const PAST_CHAT_SCOPE_TYPE = {
  matters: "matters",
  allChats: "all-chats",
} as const;

/**
 * Which of the user's other chats `search-past-chats` reads. A chat bound to
 * a matter, or pinned to matters, searches only chats about those matters;
 * `search-all-past-chats` widens to every chat after the user approves it.
 * This is a consent boundary against mixing matters, not an access boundary:
 * RLS already limits every read to the user's own chats in accessible matters.
 */
export type PastChatScope =
  | {
      type: typeof PAST_CHAT_SCOPE_TYPE.matters;
      workspaceIds: readonly SafeId<"workspace">[];
    }
  | { type: typeof PAST_CHAT_SCOPE_TYPE.allChats };

type ResolvePastChatScopeArgs = {
  threadWorkspaceId: SafeId<"workspace"> | null;
  /** Pins already intersected with the accessible set. */
  contextMatterIds: readonly SafeId<"workspace">[];
};

export const resolvePastChatScope = ({
  threadWorkspaceId,
  contextMatterIds,
}: ResolvePastChatScopeArgs): PastChatScope => {
  const workspaceIds = [
    ...new Set([
      ...(threadWorkspaceId === null ? [] : [threadWorkspaceId]),
      ...contextMatterIds,
    ]),
  ];
  return workspaceIds.length === 0
    ? { type: PAST_CHAT_SCOPE_TYPE.allChats }
    : { type: PAST_CHAT_SCOPE_TYPE.matters, workspaceIds };
};

const PAST_CHAT_HEADLINE_CONFIG =
  "StartSel=<hit>, StopSel=</hit>, MaxWords=40, MinWords=10, ShortWord=3";

const MATTER_SCOPE_HINT = `Only chats about this chat's matters were searched. If the answer may be in another chat, call ${SEARCH_ALL_PAST_CHATS_TOOL_NAME}; the user is asked to approve that wider search.`;

const searchPastChatsInputSchema = v.strictObject({
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
    v.description("Text to search for in the user's earlier chats."),
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

const searchPastChatsOutputSchema = v.strictObject({
  query: v.string(),
  scope: v.picklist(Object.values(PAST_CHAT_SCOPE_TYPE)),
  hint: v.nullable(v.string()),
  results: v.array(
    v.strictObject({
      threadId: v.string(),
      threadTitle: v.string(),
      matterRef: v.nullable(v.string()),
      messageId: v.string(),
      role: v.string(),
      excerpt: v.string(),
      createdAt: v.string(),
    }),
  ),
});

type PastChatSearchRow = {
  createdAt: Date;
  dataWorkspaceIds: SafeId<"workspace">[];
  excerpt: string;
  messageId: SafeId<"chatMessage">;
  role: ChatMessageRole;
  threadId: SafeId<"chatThread">;
  threadTitle: string;
  workspaceId: SafeId<"workspace"> | null;
};

type CreatePastChatToolsProps = {
  organizationId: SafeId<"organization">;
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
  scope: PastChatScope;
  threadId: SafeId<"chatThread">;
  userId: SafeId<"user">;
};

/**
 * `AND …` predicate over a `chat_threads` row aliased `t`. A matter scope
 * admits a chat only when every matter it touches is in scope: its own matter
 * (if any) and every matter whose data it embedded. A chat that also carries
 * another matter's data is reachable only through the approval-gated
 * widening. A global chat with no matter data is about no matter, so it too
 * waits for the widening.
 */
export const pastChatScopeSql = (scope: PastChatScope): SQL => {
  switch (scope.type) {
    case PAST_CHAT_SCOPE_TYPE.allChats:
      return sql``;
    case PAST_CHAT_SCOPE_TYPE.matters: {
      const workspaceIds = typedPgArray(scope.workspaceIds, "uuid");
      return sql`AND (t.workspace_id IS NULL OR t.workspace_id = ANY(${workspaceIds}))
        AND t.data_workspace_ids <@ ${workspaceIds}
        AND (t.workspace_id IS NOT NULL OR cardinality(t.data_workspace_ids) > 0)`;
    }
    default:
      scope satisfies never;
      return panic(`Unhandled past-chat scope: ${String(scope)}`);
  }
};

export const createPastChatTools = ({
  organizationId,
  refRegistry,
  safeDb,
  scope,
  threadId,
  userId,
}: CreatePastChatToolsProps) => {
  const searchPastChats = async ({
    limit,
    query,
    searchScope,
  }: {
    limit: number | undefined;
    query: string;
    searchScope: PastChatScope;
  }) => {
    const normalizedQuery = query.trim();
    const hint =
      searchScope.type === PAST_CHAT_SCOPE_TYPE.matters
        ? MATTER_SCOPE_HINT
        : null;
    // The schema requires one character, so only a whitespace query lands here.
    if (!normalizedQuery) {
      return {
        query: normalizedQuery,
        scope: searchScope.type,
        hint,
        results: [],
      };
    }

    const tsQuery = buildSearchTsQuery(normalizedQuery);
    // RLS scopes both tables to the caller's own chats in accessible matters;
    // the explicit user/org predicates keep the query correct on its own.
    const result = await safeDb((tx) =>
      tx.execute<PastChatSearchRow>(sql`
        SELECT
          d.message_id AS "messageId",
          d.thread_id AS "threadId",
          t.title AS "threadTitle",
          t.workspace_id AS "workspaceId",
          t.data_workspace_ids AS "dataWorkspaceIds",
          d.role,
          ts_headline(
            'simple',
            left(d.searchable_text, 2000),
            ${tsQuery},
            ${PAST_CHAT_HEADLINE_CONFIG}
          ) AS excerpt,
          d.created_at AS "createdAt"
        FROM chat_message_search_documents d
        JOIN chat_threads t ON t.id = d.thread_id
        WHERE d.tsv @@ ${tsQuery}
          AND d.thread_id <> ${threadId}
          AND t.user_id = ${userId}
          AND t.organization_id = ${organizationId}
          ${pastChatScopeSql(searchScope)}
        ORDER BY ts_rank(d.tsv, ${tsQuery}) DESC, d.created_at DESC, d.message_id DESC
        LIMIT ${limit ?? LIMITS.chatHistorySearchPageSizeDefault}
      `),
    );
    const rows = result.unwrap("Failed to search past chats.");

    return {
      query: normalizedQuery,
      scope: searchScope.type,
      hint,
      results: rows.map((row) => {
        // Registering every matter the source chat embeds folds them into
        // this thread's data scope at turn end, so copied content cannot
        // outlive the user's access to its matter.
        for (const workspaceId of row.dataWorkspaceIds) {
          refRegistry.toMatterRef(workspaceId);
        }
        return {
          threadId: row.threadId,
          threadTitle: row.threadTitle,
          matterRef:
            row.workspaceId === null
              ? null
              : refRegistry.toMatterRef(row.workspaceId),
          messageId: row.messageId,
          role: row.role,
          excerpt: refRegistry.hydrateAssistantTextRefs(row.excerpt),
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  };

  const searchTool = toolDefinition({
    name: SEARCH_PAST_CHATS_TOOL_NAME,
    description:
      scope.type === PAST_CHAT_SCOPE_TYPE.matters
        ? `Search the user's earlier chats about this chat's matters (not this chat; use search-chat-history for that). Use when the user refers to an earlier conversation or a detail discussed before. Follow up with expand-chat-history for surrounding context. When nothing relevant is found, call ${SEARCH_ALL_PAST_CHATS_TOOL_NAME}.`
        : "Search all the user's earlier chats (not this chat; use search-chat-history for that). Use when the user refers to an earlier conversation or a detail discussed before. Follow up with expand-chat-history for surrounding context.",
    inputSchema: toTanStackToolSchema(searchPastChatsInputSchema),
    outputSchema: toTanStackToolSchema(searchPastChatsOutputSchema),
  }).server(
    async ({ limit, query }) =>
      await searchPastChats({ limit, query, searchScope: scope }),
  );

  const searchAllTool = toolDefinition({
    name: SEARCH_ALL_PAST_CHATS_TOOL_NAME,
    description: `Search all the user's earlier chats, including chats about other matters. The user is asked to approve it. Call it when ${SEARCH_PAST_CHATS_TOOL_NAME} found nothing relevant, or when the user asks to search all chats. Results from chats outside this chat's matters cannot be expanded; search again with a more specific query instead.`,
    inputSchema: toTanStackToolSchema(searchPastChatsInputSchema),
    outputSchema: toTanStackToolSchema(searchPastChatsOutputSchema),
  }).server(
    async ({ limit, query }) =>
      await searchPastChats({
        limit,
        query,
        searchScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
      }),
  );

  return {
    [SEARCH_PAST_CHATS_TOOL_NAME]: searchTool,
    [SEARCH_ALL_PAST_CHATS_TOOL_NAME]: searchAllTool,
  };
};
