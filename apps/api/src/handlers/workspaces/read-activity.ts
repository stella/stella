import { Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { t } from "elysia";

import { chatMessages, chatThreads, entities } from "@/api/db/schema";
import {
  decodeWorkspaceActivityCursor,
  encodeWorkspaceActivityCursor,
  type WorkspaceActivityType,
} from "@/api/handlers/workspaces/activity-cursor";
import {
  resolveWorkspaceActivityScope,
  WORKSPACE_ACTIVITY_PERMISSIONS,
  WORKSPACE_ACTIVITY_SCOPE,
} from "@/api/handlers/workspaces/activity-scope";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: WORKSPACE_ACTIVITY_PERMISSIONS,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: t.Object({
    cursor: t.Optional(t.String({ maxLength: 512 })),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.workspaceActivityPageSizeMax,
      }),
    ),
  }),
} satisfies HandlerConfig;

type InternalActivity =
  | {
      activityAt: Date;
      cursorActivityAt: string;
      entityKind: (typeof entities.$inferSelect)["kind"];
      id: string;
      status: string | null;
      title: string;
      type: "entity";
    }
  | {
      activityAt: Date;
      cursorActivityAt: string;
      id: string;
      title: string;
      type: "thread";
    };

type WorkspaceActivity =
  | {
      activityAt: string;
      entityKind: (typeof entities.$inferSelect)["kind"];
      id: string;
      status: string | null;
      title: string;
      type: "entity";
    }
  | {
      activityAt: string;
      id: string;
      title: string;
      type: "thread";
    };

const readWorkspaceActivity = createSafeHandler(
  config,
  async function* ({ memberRole, query, safeDb, session, user, workspaceId }) {
    const limit = query.limit ?? LIMITS.workspaceActivityPageSizeDefault;
    const cursor = decodeWorkspaceActivityCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    const entityActivityAt = sql<Date>`coalesce(${entities.updatedAt}, ${entities.createdAt})`;
    const entityCursorActivityAt = sql<string>`to_char(
      ${entityActivityAt},
      'YYYY-MM-DD"T"HH24:MI:SS.US'
    )`;
    const threadCursorActivityAt = sql<string>`to_char(
      ${chatThreads.updatedAt},
      'YYYY-MM-DD"T"HH24:MI:SS.US'
    )`;

    const entityCursorCondition = activityCursorCondition({
      activityAt: entityActivityAt,
      cursor,
      id: entities.id,
      type: "entity",
    });
    const threadCursorCondition = activityCursorCondition({
      activityAt: chatThreads.updatedAt,
      cursor,
      id: chatThreads.id,
      type: "thread",
    });
    const activityScope = resolveWorkspaceActivityScope(memberRole);

    const { entityRows, threadRows } = yield* Result.await(
      safeDb(async (tx) => {
        const entityRowsQuery = tx
          .select({
            activityAt: entityActivityAt,
            cursorActivityAt: entityCursorActivityAt,
            entityKind: entities.kind,
            id: entities.id,
            status: entities.status,
            title: entities.name,
          })
          .from(entities)
          .where(
            and(
              eq(entities.workspaceId, workspaceId),
              ...(entityCursorCondition ? [entityCursorCondition] : []),
            ),
          )
          .orderBy(desc(entityActivityAt), desc(entities.id))
          .limit(limit + 1);

        if (activityScope === WORKSPACE_ACTIVITY_SCOPE.entities) {
          return { entityRows: await entityRowsQuery, threadRows: [] };
        }

        const [entityRows, threadRows] = await Promise.all([
          entityRowsQuery,
          tx
            .select({
              activityAt: chatThreads.updatedAt,
              cursorActivityAt: threadCursorActivityAt,
              id: chatThreads.id,
              title: chatThreads.title,
            })
            .from(chatThreads)
            .where(
              and(
                eq(chatThreads.organizationId, session.activeOrganizationId),
                eq(chatThreads.userId, user.id),
                eq(chatThreads.workspaceId, workspaceId),
                sql`exists (
                  select 1
                  from ${chatMessages}
                  where ${chatMessages.threadId} = ${chatThreads.id}
                )`,
                ...(threadCursorCondition ? [threadCursorCondition] : []),
              ),
            )
            .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id))
            .limit(limit + 1),
        ]);
        return { entityRows, threadRows };
      }),
    );

    const merged: InternalActivity[] = [];
    for (const row of entityRows) {
      merged.push({
        activityAt: row.activityAt,
        cursorActivityAt: row.cursorActivityAt,
        entityKind: row.entityKind,
        id: row.id,
        status: row.status,
        title: row.title,
        type: "entity",
      });
    }
    for (const row of threadRows) {
      merged.push({
        activityAt: row.activityAt,
        cursorActivityAt: row.cursorActivityAt,
        id: row.id,
        title: row.title,
        type: "thread",
      });
    }
    merged.sort(compareActivity);
    const pageItems = merged.slice(0, limit);
    const lastItem = pageItems.at(-1);
    const items: WorkspaceActivity[] = [];
    for (const item of pageItems) {
      if (item.type === "entity") {
        items.push({
          activityAt: item.activityAt.toISOString(),
          entityKind: item.entityKind,
          id: item.id,
          status: item.status,
          title: item.title,
          type: item.type,
        });
        continue;
      }
      items.push({
        activityAt: item.activityAt.toISOString(),
        id: item.id,
        title: item.title,
        type: item.type,
      });
    }

    return Result.ok({
      items,
      limit,
      nextCursor:
        merged.length > limit && lastItem
          ? encodeWorkspaceActivityCursor({
              activityAt: lastItem.cursorActivityAt,
              id: lastItem.id,
              type: lastItem.type,
            })
          : null,
    });
  },
);

type ActivityCursorConditionOptions = {
  activityAt: SQLWrapper;
  cursor: ReturnType<typeof decodeWorkspaceActivityCursor>;
  id: SQLWrapper;
  type: WorkspaceActivityType;
};

const activityCursorCondition = ({
  activityAt,
  cursor,
  id,
  type,
}: ActivityCursorConditionOptions): SQL | undefined => {
  if (!cursor) {
    return undefined;
  }

  return sql`(${activityAt}, ${id}, ${type}) < (${cursor.activityAt}::timestamp, ${cursor.id}::uuid, ${cursor.type})`;
};

const compareActivity = (
  left: InternalActivity,
  right: InternalActivity,
): number => {
  const timestampOrder = compareDescending(
    left.cursorActivityAt,
    right.cursorActivityAt,
  );
  if (timestampOrder !== 0) {
    return timestampOrder;
  }

  const idOrder = compareDescending(left.id, right.id);
  if (idOrder !== 0) {
    return idOrder;
  }

  return compareDescending(left.type, right.type);
};

const compareDescending = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? 1 : -1;
};

export default readWorkspaceActivity;
