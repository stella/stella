import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { notifications } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Mark every unread notification the caller has in their active " +
    "organization as read. Notifications in the caller's other organizations " +
    "are untouched. Answers with how many were marked.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "native_tool_ui" },
  access: "write",
} satisfies HandlerConfig;

const markAllNotificationsRead = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    // audit: skip — per-user read-state bookkeeping; no shared resource changes
    const updated = yield* Result.await(
      safeDb((tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.userId, user.id),
              eq(notifications.organizationId, session.activeOrganizationId),
              isNull(notifications.readAt),
            ),
          )
          .returning({ id: notifications.id }),
      ),
    );

    // Everything unread in this organization was just marked, so the count is
    // zero by construction rather than by a follow-up query.
    return Result.ok({ markedCount: updated.length, unreadCount: 0 });
  },
);

export default markAllNotificationsRead;
