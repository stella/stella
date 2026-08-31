import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { notifications } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";

import {
  notificationCursor,
  readUnreadCount,
  toNotificationListItem,
} from "./read-model";

const config = {
  description:
    "List the caller's own notifications in their active organization, newest " +
    "first, with the unread count. Notifications are awareness pointers " +
    "(mentions, finished exports, flow-run outcomes, announcements) and carry " +
    "no work state; they are read or unread and nothing else.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "native_tool_ui" },
  access: "read",
  query: t.Object({
    limit: t.Optional(tPaginationLimit(LIMITS.notificationsPageSizeMax)),
    cursor: t.Optional(tPaginationCursor()),
  }),
} satisfies HandlerConfig;

const listNotifications = createSafeRootHandler(
  config,
  async function* ({
    query: { cursor: encodedCursor, limit: requestedLimit },
    safeDb,
    session,
    user,
  }) {
    const limit = requestedLimit ?? LIMITS.notificationsPageSizeDefault;

    const cursor = encodedCursor
      ? notificationCursor.decode(encodedCursor)
      : null;
    if (encodedCursor && !cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }

    // RLS already pins every row to this user. The organization filter is the
    // product rule on top of it: somebody who belongs to several firms sees
    // only what happened in the firm they are working in.
    const conditions: SQL[] = [
      eq(notifications.userId, user.id),
      eq(notifications.organizationId, session.activeOrganizationId),
    ];
    if (cursor) {
      const keysetCondition = notificationCursor.keysetAfter({
        cursor,
        idColumn: notifications.id,
        direction: "descending",
      });
      if (keysetCondition) {
        conditions.push(keysetCondition);
      }
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: notifications.id,
            kind: notifications.kind,
            metadata: notifications.metadata,
            entityType: notifications.entityType,
            entityId: notifications.entityId,
            workspaceId: notifications.workspaceId,
            readAt: notifications.readAt,
            createdAt: notifications.createdAt,
            createdAtCursor:
              notificationCursor.cursorValue.as("created_at_cursor"),
          })
          .from(notifications)
          .where(and(...conditions))
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(limit + 1),
      ),
    );

    // Counted server-side on every page so the badge is the truth for the
    // whole history, not for the page the client happens to hold.
    const unreadCount = yield* Result.await(
      readUnreadCount(safeDb, {
        organizationId: session.activeOrganizationId,
        userId: user.id,
      }),
    );

    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        notificationCursor.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      items: page.items.map(toNotificationListItem),
      nextCursor: page.nextCursor,
      limit: page.limit,
      unreadCount,
    });
  },
);

export default listNotifications;
