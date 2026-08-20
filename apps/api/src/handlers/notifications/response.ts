import type { SafeId } from "@/api/lib/branded-types";

export type NotificationResponse = {
  id: SafeId<"notification">;
  kind: string;
  metadata: Record<string, string | number | boolean | null>;
  isRead: boolean;
  readAt: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

export const toNotificationResponse = (row: {
  id: SafeId<"notification">;
  kind: string;
  metadata: Record<string, string | number | boolean | null> | null;
  isRead: boolean;
  readAt: Date | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: Date;
}): NotificationResponse => ({
  id: row.id,
  kind: row.kind,
  metadata: row.metadata ?? {},
  isRead: row.isRead,
  readAt: row.readAt?.toISOString() ?? null,
  entityType: row.entityType,
  entityId: row.entityId,
  createdAt: row.createdAt.toISOString(),
});
