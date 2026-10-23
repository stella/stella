import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { notifications } from "@/api/db/schema";
import {
  notificationParamsSchema,
  readUnreadCount,
} from "@/api/handlers/notifications/read-model";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Mark one of the caller's notifications read. Idempotent: marking an " +
    "already-read notification succeeds and changes nothing. Answers with the " +
    "caller's remaining unread count.",
  // permissions-exempt: the write touches only the caller's own notification
  // rows (user-scoped RLS); workspace:read is the access floor.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "notification_inbox",
    consumesServices: false,
  },
  realtime: noResourceSetUpdates(
    "Read state belongs only to the caller, who receives the updated unread count in this response.",
  ),
  access: "write",
  params: notificationParamsSchema,
} satisfies HandlerConfig;

const markNotificationRead = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user }) {
    const updated = yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — per-user read-state bookkeeping; no shared resource changes
        const rows = await tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.id, params.notificationId),
              eq(notifications.userId, user.id),
              eq(notifications.organizationId, session.activeOrganizationId),
              // Preserve the original read instant on a repeat click.
              isNull(notifications.readAt),
            ),
          )
          .returning({ id: notifications.id });
        return rows;
      }),
    );

    if (updated.length === 0) {
      // Either already read or not the caller's. Distinguish so a stale panel
      // does not surface an error for a notification it already marked.
      const exists = yield* Result.await(
        safeDb(
          async (tx) =>
            await tx.$count(
              notifications,
              and(
                eq(notifications.id, params.notificationId),
                eq(notifications.userId, user.id),
                eq(notifications.organizationId, session.activeOrganizationId),
              ),
            ),
        ),
      );
      if (exists === 0) {
        return Result.err(
          new HandlerError({ status: 404, message: "Notification not found" }),
        );
      }
    }

    const unreadCount = yield* Result.await(
      readUnreadCount(safeDb, {
        organizationId: session.activeOrganizationId,
        userId: user.id,
      }),
    );
    return Result.ok({ unreadCount });
  },
);

declareAggregateMutation(markNotificationRead, {
  type: "independent",
  reason:
    "Updates one caller-owned notification idempotently; unread count is a read-only response projection.",
});

export default markNotificationRead;
