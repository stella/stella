import type { SafeId } from "@/api/lib/branded-types";

export type NotificationResponse = {
  id: SafeId<"notification">;
  title: string;
  message: string;
  isRead: boolean;
  readAt: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

export const toNotificationResponse = (row: {
  id: SafeId<"notification">;
  title: string;
  message: string;
  isRead: boolean;
  readAt: Date | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: Date;
}): NotificationResponse => ({
  id: row.id,
  title: row.title,
  message: row.message,
  isRead: row.isRead,
  readAt: row.readAt?.toISOString() ?? null,
  entityType: row.entityType,
  entityId: row.entityId,
  createdAt: row.createdAt.toISOString(),
});
