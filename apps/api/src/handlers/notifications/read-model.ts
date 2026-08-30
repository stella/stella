import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import type {
  NotificationEntityType,
  NotificationKind,
  NotificationMetadataValue,
} from "@stll/api-contract/notifications";

import type { SafeDb } from "@/api/db/safe-db";
import { notifications } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { brandPersistedNotificationId } from "@/api/lib/safe-id-boundaries";

export const notificationParamsSchema = t.Object({
  notificationId: tSafeId("notification"),
});

export const notificationCursor = createTimestampIdCursorCodec({
  column: notifications.createdAt,
  brandId: brandPersistedNotificationId,
});

export type NotificationListItem = {
  id: SafeId<"notification">;
  kind: NotificationKind;
  metadata: NotificationMetadataValue;
  entityType: NotificationEntityType | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};

export const toNotificationListItem = (row: {
  id: SafeId<"notification">;
  kind: NotificationKind;
  metadata: NotificationMetadataValue;
  entityType: NotificationEntityType | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationListItem => ({
  id: row.id,
  kind: row.kind,
  metadata: row.metadata,
  entityType: row.entityType,
  entityId: row.entityId,
  readAt: row.readAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Unread notifications for one user in one organization.
 *
 * Counted in the database rather than derived from the page the client holds:
 * the panel shows a bounded page, so a client-side count would report "20"
 * forever once history exceeds a page. Served by the partial unread index, so
 * the scan is proportional to what is unread, not to the whole history.
 */
export const readUnreadCount = async (
  safeDb: SafeDb,
  {
    organizationId,
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
) =>
  await safeDb(
    async (tx) =>
      await tx.$count(
        notifications,
        and(
          eq(notifications.userId, userId),
          eq(notifications.organizationId, organizationId),
          isNull(notifications.readAt),
        ),
      ),
  );
