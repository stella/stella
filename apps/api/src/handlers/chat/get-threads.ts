import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
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
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";

const config = {
  description:
    "List your own chat threads, most recently active first, split into " +
    "global threads and groups per matter. Threads with no messages, and " +
    "threads belonging to a matter that is being deleted, are left out. " +
    "search matches the thread title or the matter name; paginate with limit " +
    "and cursor.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "capability", reason: "assistant_chat" },
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
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      const searchCondition = or(
        ilike(chatThreads.title, pattern),
        ilike(workspacesTable.name, pattern),
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }
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

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
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
          .where(and(...conditions))
          .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id))
          .limit(limit + 1),
      ),
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

    const global: {
      id: string;
      origin: ChatThreadOrigin;
      title: string;
      createdAt: Date;
      updatedAt: Date;
      usedAnonymization: boolean;
    }[] = [];

    const groupedWorkspaceThreads = new Map<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        threads: {
          id: string;
          origin: ChatThreadOrigin;
          title: string;
          createdAt: Date;
          updatedAt: Date;
          usedAnonymization: boolean;
        }[];
      }
    >();

    for (const thread of page) {
      const origin =
        thread.forkedFromMessageId === null
          ? CHAT_THREAD_ORIGIN.original
          : CHAT_THREAD_ORIGIN.fork;
      if (thread.workspaceId === null) {
        global.push({
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

    const workspaceGroups = Array.from(groupedWorkspaceThreads.values()).sort(
      (left, right) => {
        const leftUpdatedAt = left.threads.at(0)?.updatedAt.getTime() ?? 0;
        const rightUpdatedAt = right.threads.at(0)?.updatedAt.getTime() ?? 0;

        return rightUpdatedAt - leftUpdatedAt;
      },
    );

    return Result.ok({
      global,
      nextCursor,
      workspaces: workspaceGroups,
    });
  },
);

export default getThreads;
