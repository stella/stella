import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { notifications } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import { readUnreadCount } from "./read-model";

const config = {
  description:
    "Mark every unread notification the caller has in their active " +
    "organization as read. Notifications in the caller's other organizations " +
    "are untouched. Answers with how many were marked.",
  // permissions-exempt: the write touches only the caller's own notification
  // rows (user-scoped RLS); workspace:read is the access floor.
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "native_tool_ui" },
  access: "write",
} satisfies HandlerConfig;

const markAllNotificationsRead = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const updated = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — per-user read-state bookkeeping; no shared resource changes
        const rows = await tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.userId, user.id),
              eq(notifications.organizationId, session.activeOrganizationId),
              isNull(notifications.readAt),
            ),
          )
          .returning({ id: notifications.id });
        return rows;
      }),
    );

    // Counted after the update rather than assumed to be zero: a notification
    // filed between the UPDATE and this read is genuinely unread, and a hard
    // zero would clear the badge and the favicon dot for it. Same read the
    // single-notification endpoint answers with, so the two cannot disagree.
    const unreadCount = yield* Result.await(
      readUnreadCount(safeDb, {
        organizationId: session.activeOrganizationId,
        userId: user.id,
      }),
    );

    return Result.ok({ markedCount: updated.length, unreadCount });
  },
);

export default markAllNotificationsRead;
