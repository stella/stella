import { Result } from "better-result";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaces, workspaceViews } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

const WORKSPACE_NAVIGATION_STATUS_SCOPE = {
  ACTIVE: "active",
  ACTIVE_AND_ARCHIVED: "active-and-archived",
} as const;

const NON_DELETING_WORKSPACE_STATUSES = ["active", "archived"] as const;

export const workspaceNavigationCursor = createTimestampIdCursorCodec({
  column: workspaces.lastActivityAt,
  brandId: brandPersistedWorkspaceId,
});

const config = {
  permissions: {
    workspace: ["read"],
  },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: t.Object({
    cursor: t.Optional(tPaginationCursor()),
    limit: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: LIMITS.workspaceNavigationPageSizeMax,
      }),
    ),
    statusScope: t.Optional(
      t.Union([
        t.Literal(WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE),
        t.Literal(WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE_AND_ARCHIVED),
      ]),
    ),
  }),
} satisfies HandlerConfig;

const readWorkspaceNavigation = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const statusScope =
      query.statusScope ?? WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE;
    const limit =
      query.limit ??
      (statusScope === WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE
        ? LIMITS.workspacesCount
        : LIMITS.workspaceNavigationPageSizeDefault);
    const conditions = [
      eq(workspaces.organizationId, session.activeOrganizationId),
      statusScope === WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE
        ? eq(workspaces.status, "active")
        : inArray(workspaces.status, NON_DELETING_WORKSPACE_STATUSES),
    ];

    if (query.cursor) {
      const cursor = workspaceNavigationCursor.decode(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const cursorCondition = workspaceNavigationCursor.keysetAfter({
        cursor,
        idColumn: workspaces.id,
        direction: "descending",
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            defaultViewId: sql<typeof workspaceViews.$inferSelect.id | null>`(
              select ${workspaceViews.id}
              from ${workspaceViews}
              where ${workspaceViews.workspaceId} = ${workspaces.id}
              order by ${workspaceViews.position}, ${workspaceViews.id}
              limit 1
            )`.as("default_view_id"),
            id: workspaces.id,
            name: workspaces.name,
            reference: workspaces.reference,
            clientId: workspaces.clientId,
            color: workspaces.color,
            status: workspaces.status,
            lastActivityAt: workspaces.lastActivityAt,
            lastActivityAtCursor: workspaceNavigationCursor.cursorValue.as(
              "last_activity_at_cursor",
            ),
            clientRecordId: contacts.id,
            clientDisplayName: contacts.displayName,
          })
          .from(workspaces)
          .leftJoin(
            contacts,
            and(
              eq(contacts.id, workspaces.clientId),
              eq(contacts.organizationId, session.activeOrganizationId),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(workspaces.lastActivityAt), desc(workspaces.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        workspaceNavigationCursor.encode(item.lastActivityAtCursor, item.id),
    });
    const items = page.items.map(
      ({
        clientDisplayName,
        clientRecordId,
        lastActivityAtCursor: _lastActivityAtCursor,
        ...row
      }) => ({
        ...row,
        client:
          clientRecordId === null || clientDisplayName === null
            ? null
            : { id: clientRecordId, displayName: clientDisplayName },
      }),
    );

    return Result.ok({
      items,
      limit: page.limit,
      nextCursor: page.nextCursor,
      // Compatibility field for active navigation consumers. The memory
      // picker reads the standard page fields above and follows nextCursor.
      workspaces: items,
    });
  },
);

export default readWorkspaceNavigation;
