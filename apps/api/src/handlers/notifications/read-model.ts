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
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { brandPersistedNotificationId } from "@/api/lib/safe-id-boundaries";

type NotificationRow = typeof notifications.$inferSelect;

// Columns intentionally not sent to the client.
const UNPROJECTED_NOTIFICATION_COLUMNS = [
  // RLS already pins every row to the caller; re-stating it client-side
  // would be redundant with the identity the client already has.
  "userId",
  // The list endpoint scopes to the caller's active organization, which the
  // client already knows from its own session.
  "organizationId",
  // Producer-only dedup key for replay-safe inserts; never read back.
  "idempotencyKey",
] as const satisfies readonly (keyof NotificationRow)[];

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
  /**
   * The matter the pointer lives in, or null for a kind that points at nothing
   * and for a pointer whose matter has since been deleted. The client renders a
   * link only when it has all three, so a stale pointer degrades to plain text
   * rather than to a route that cannot resolve.
   */
  workspaceId: SafeId<"workspace"> | null;
  readAt: string | null;
  createdAt: string;
};

export const toNotificationListItem = (row: {
  id: SafeId<"notification">;
  kind: NotificationKind;
  metadata: NotificationMetadataValue;
  entityType: NotificationEntityType | null;
  entityId: string | null;
  workspaceId: SafeId<"workspace"> | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationListItem => ({
  id: row.id,
  kind: row.kind,
  metadata: row.metadata,
  entityType: row.entityType,
  entityId: row.entityId,
  workspaceId: row.workspaceId,
  readAt: row.readAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedNotificationColumn = UnprojectedColumns<
  NotificationRow,
  NotificationListItem,
  (typeof UNPROJECTED_NOTIFICATION_COLUMNS)[number]
>;
type UnexpectedProjectedNotificationColumn = UnbackedProjectionKeys<
  NotificationRow,
  NotificationListItem
>;

true satisfies MissingProjectedNotificationColumn extends never ? true : never;
true satisfies UnexpectedProjectedNotificationColumn extends never
  ? true
  : never;

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
