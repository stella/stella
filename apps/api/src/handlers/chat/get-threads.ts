import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { chatThreads, workspaces as workspacesTable } from "@/api/db/schema";
import {
  decodeChatThreadListCursor,
  encodeChatThreadListCursor,
} from "@/api/handlers/chat/thread-list-pagination";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { chat: ["create"] },
  query: t.Object({
    cursor: t.Optional(t.String({ maxLength: 512 })),
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
  async function* ({ accessibleWorkspaces, query, safeDb, session, user }) {
    const limit = query.limit ?? LIMITS.chatThreadListPageSizeDefault;
    const cursor = query.cursor
      ? decodeChatThreadListCursor(query.cursor)
      : null;
    if (query.cursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const visibleWorkspaceIds = accessibleWorkspaces
      .filter((w) => w.status !== "deleting")
      .map((w) => w.id);
    const conditions: SQL[] = [
      eq(chatThreads.organizationId, session.activeOrganizationId),
      eq(chatThreads.userId, user.id),
    ];
    const visibleWorkspaceCondition =
      visibleWorkspaceIds.length > 0
        ? or(
            isNull(chatThreads.workspaceId),
            inArray(chatThreads.workspaceId, visibleWorkspaceIds),
          )
        : isNull(chatThreads.workspaceId);
    if (visibleWorkspaceCondition) {
      conditions.push(visibleWorkspaceCondition);
    }
    if (cursor) {
      conditions.push(
        sql`(${chatThreads.updatedAt}, ${chatThreads.id}) < (${cursor.updatedAt}::timestamp, ${cursor.id}::uuid)`,
      );
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            createdAt: chatThreads.createdAt,
            id: chatThreads.id,
            title: chatThreads.title,
            updatedAt: chatThreads.updatedAt,
            updatedAtCursor: sql<string>`to_char(
              ${chatThreads.updatedAt},
              'YYYY-MM-DD"T"HH24:MI:SS.US'
            )`,
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
      title: string;
      createdAt: Date;
      updatedAt: Date;
    }[] = [];

    const groupedWorkspaceThreads = new Map<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        threads: {
          id: string;
          title: string;
          createdAt: Date;
          updatedAt: Date;
        }[];
      }
    >();

    for (const thread of page) {
      if (thread.workspaceId === null) {
        global.push({
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        });
        continue;
      }

      if (thread.workspaceName === null) {
        continue;
      }

      const slice = {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
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
