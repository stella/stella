import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, arrayOverlaps, desc, eq, ilike, or, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  CHAT_THREAD_ORIGIN,
  type ChatThreadOrigin,
} from "@stll/api-contract/chat";

import {
  chatMessages,
  chatThreads,
  workspaces as workspacesTable,
} from "@/api/db/schema";
import {
  chatThreadListCursorCodec,
  encodeChatThreadListCursor,
} from "@/api/handlers/chat/thread-list-pagination";
import {
  EMPTY_CHAT_THREAD_CONTEXT,
  readChatThreadContexts,
} from "@/api/handlers/chat/threads/list-context";
import type { ChatThreadContext } from "@/api/handlers/chat/threads/list-context";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";

/** Most matching matters a search widens to (pinned or embedded matters). */
const CHAT_THREAD_SEARCH_MATTER_LIMIT = 50;

type ChatThreadListItem = {
  context: ChatThreadContext;
  id: string;
  origin: ChatThreadOrigin;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  usedAnonymization: boolean;
};

const config = {
  description:
    "List your own chat threads, most recently active first, split into " +
    "global threads and groups per matter. Threads with no messages, and " +
    "threads belonging to a matter that is being deleted, are left out. " +
    "Each thread carries a bounded preview of its context: the matters and " +
    "files it drew on, with their total counts. search matches the thread " +
    "title, the matter it lives in, or a matter pinned to it; paginate with " +
    "limit and cursor.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: {
    type: "capability",
    reason: "assistant_chat",
    consumesServices: false,
  },
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    search: t.Optional(t.String({ maxLength: LIMITS.searchQueryMaxLength })),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.chatThreadListPageSizeMax,
      }),
    ),
  }),
} satisfies HandlerConfig;

const getThreads = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session, user }) {
    const limit = query.limit ?? LIMITS.chatThreadListPageSizeDefault;
    const cursor = query.cursor
      ? chatThreadListCursorCodec.decode(query.cursor)
      : null;
    if (query.cursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const conditions: SQL[] = [
      eq(chatThreads.organizationId, session.activeOrganizationId),
      eq(chatThreads.userId, user.id),
      sql`(
        ${chatThreads.workspaceId} IS NULL
        OR ${workspacesTable.status} <> 'deleting'
      )`,
      sql`exists (
        select 1
        from ${chatMessages}
        where ${chatMessages.threadId} = ${chatThreads.id}
      )`,
    ];
    const search = query.search?.trim();
    const searchPattern = search ? `%${escapeLike(search)}%` : null;
    // Membership-mode RLS filters workspace-scoped threads and verifies every
    // data_workspace_ids entry on global threads without materializing an
    // application-side workspace allowlist. The joined status predicate keeps
    // deleting workspaces sealed at the product layer.
    if (cursor) {
      const cursorCondition = chatThreadListCursorCodec.keysetAfter({
        cursor,
        direction: "descending",
        idColumn: chatThreads.id,
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const { contexts, rows } = yield* Result.await(
      safeDb(async (tx) => {
        const listConditions = [...conditions];
        if (searchPattern !== null) {
          // A matter pinned to a thread, or whose data it embedded, matches
          // by name too. One lookup of the organization's matching matters
          // (RLS keeps it to matters the user can open), not one per thread.
          const matchingMatters = await tx
            .select({ id: workspacesTable.id })
            .from(workspacesTable)
            .where(
              and(
                eq(
                  workspacesTable.organizationId,
                  session.activeOrganizationId,
                ),
                ilike(workspacesTable.name, searchPattern),
              ),
            )
            .limit(CHAT_THREAD_SEARCH_MATTER_LIMIT);
          const matchingMatterIds = matchingMatters.map((matter) => matter.id);
          const searchCondition = or(
            ilike(chatThreads.title, searchPattern),
            ilike(workspacesTable.name, searchPattern),
            ...(matchingMatterIds.length > 0
              ? [
                  arrayOverlaps(
                    chatThreads.contextMatterIds,
                    matchingMatterIds,
                  ),
                  arrayOverlaps(
                    chatThreads.dataWorkspaceIds,
                    matchingMatterIds,
                  ),
                ]
              : []),
          );
          if (searchCondition) {
            listConditions.push(searchCondition);
          }
        }

        const listedRows = await tx
          .select({
            createdAt: chatThreads.createdAt,
            forkedFromMessageId: chatThreads.forkedFromMessageId,
            id: chatThreads.id,
            title: chatThreads.title,
            updatedAt: chatThreads.updatedAt,
            usedAnonymization: chatThreads.usedAnonymization,
            updatedAtCursor:
              chatThreadListCursorCodec.cursorValue.as("updated_at_cursor"),
            workspaceId: chatThreads.workspaceId,
            workspaceName: workspacesTable.name,
          })
          .from(chatThreads)
          .leftJoin(
            workspacesTable,
            eq(workspacesTable.id, chatThreads.workspaceId),
          )
          .where(and(...listConditions))
          .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id))
          .limit(limit + 1);

        // One bounded read for the whole page's context, never one per row.
        const threadContexts = await readChatThreadContexts({
          threadIds: listedRows.slice(0, limit).map((row) => row.id),
          tx,
        });
        return { contexts: threadContexts, rows: listedRows };
      }),
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = page.at(-1);
    const nextCursor =
      hasMore && lastItem
        ? encodeChatThreadListCursor({
            id: lastItem.id,
            updatedAt: lastItem.updatedAtCursor,
          })
        : null;

    const global: ChatThreadListItem[] = [];

    const groupedWorkspaceThreads = new Map<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        threads: ChatThreadListItem[];
      }
    >();

    for (const thread of page) {
      const origin =
        thread.forkedFromMessageId === null
          ? CHAT_THREAD_ORIGIN.original
          : CHAT_THREAD_ORIGIN.fork;
      const context = contexts.get(thread.id) ?? EMPTY_CHAT_THREAD_CONTEXT;
      if (thread.workspaceId === null) {
        global.push({
          context,
          id: thread.id,
          origin,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          usedAnonymization: thread.usedAnonymization,
        });
        continue;
      }

      if (thread.workspaceName === null) {
        continue;
      }

      const slice = {
        context,
        id: thread.id,
        origin,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        usedAnonymization: thread.usedAnonymization,
      };

      const existingGroup = groupedWorkspaceThreads.get(thread.workspaceId);
      if (existingGroup) {
        existingGroup.threads.push(slice);
        continue;
      }

      groupedWorkspaceThreads.set(thread.workspaceId, {
        workspaceId: thread.workspaceId,
        workspaceName: thread.workspaceName,
        threads: [slice],
      });
    }

    const workspaceGroups = Array.from(
      groupedWorkspaceThreads.values(),
    ).toSorted((left, right) => {
      const leftUpdatedAt = left.threads.at(0)?.updatedAt.getTime() ?? 0;
      const rightUpdatedAt = right.threads.at(0)?.updatedAt.getTime() ?? 0;

      return rightUpdatedAt - leftUpdatedAt;
    });

    return Result.ok({
      global,
      nextCursor,
      workspaces: workspaceGroups,
    });
  },
);

export default getThreads;
