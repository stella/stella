import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { notifications } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedNotificationId } from "@/api/lib/safe-id-boundaries";

import { toNotificationResponse } from "./response";

const config = {
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "native_tool_ui" },
  query: t.Object({
    limit: t.Optional(t.Numeric()),
    cursor: t.Optional(t.String()),
  }),
} satisfies HandlerConfig;

export const notificationCursor = createTimestampIdCursorCodec({
  column: notifications.createdAt,
  brandId: brandPersistedNotificationId,
});

const listNotifications = createSafeRootHandler(
  config,
  async function* ({ safeDb, user, query }) {
    const rawLimit = query["limit"] ?? LIMITS.notificationsPageSizeDefault;
    const limit = typeof rawLimit === "string" ? Number(rawLimit) : rawLimit;
    const conditions = [eq(notifications.userId, user.id)];

    const queryCursor = query["cursor"];
    if (queryCursor) {
      const cursor = notificationCursor.decode(queryCursor);
      if (!cursor) {
        return Result.err(new HandlerError({ status: 400, message: "Invalid cursor" }));
      }
      const cursorCondition = notificationCursor.keysetAfter({
        cursor,
        idColumn: notifications.id,
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
            id: notifications.id,
            userId: notifications.userId,
            title: notifications.title,
            message: notifications.message,
            isRead: notifications.isRead,
            readAt: notifications.readAt,
            entityType: notifications.entityType,
            entityId: notifications.entityId,
            createdAt: notifications.createdAt,
            createdAtCursor: notificationCursor.cursorValue.as("created_at_cursor"),
          })
          .from(notifications)
          .where(and(...conditions))
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (item) =>
        notificationCursor.encode(item.createdAtCursor, item.id),
    });

    return Result.ok({
      ...page,
      items: page.items.map(toNotificationResponse),
    });
  },
);

export default listNotifications;
