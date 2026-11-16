import {
  MOBILE_PUSH_DATA_KEY,
  MOBILE_PUSH_DATA_VERSION,
} from "@stll/api-contract/mobile-push";
import type { MobilePushPayload } from "@stll/api-contract/mobile-push";
import type {
  NotificationEntityType,
  NotificationKind,
} from "@stll/api-contract/notifications";
import { resolveUiLocale } from "@stll/locales";
import { pushAlertBody } from "@stll/transactional/push/push-alert";

/**
 * The parts of a notification an alert may name. Deliberately not the row:
 * `metadata` holds the actor's name, the workflow's name or an announcement's
 * title, and none of that may leave stella through Apple.
 */
export type PushNotificationPointer = {
  id: string;
  kind: NotificationKind;
  organizationId: string;
  workspaceId: string | null;
  entityType: NotificationEntityType | null;
  entityId: string | null;
};

/** iOS shows at most this on the app icon; the in-app badge is exact. */
const BADGE_MAX = 999;

/**
 * The APNs payload for one notification on one device: the kind's fixed
 * sentence in the device's language, the unread count as the badge, and the
 * opaque ids the app opens the notification by.
 */
export const buildMobilePushPayload = ({
  notification,
  locale,
  unreadCount,
}: {
  notification: PushNotificationPointer;
  locale: string;
  unreadCount: number | null;
}): MobilePushPayload => ({
  aps: {
    alert: {
      body: pushAlertBody(resolveUiLocale(locale) ?? "en", notification.kind),
    },
    sound: "default",
    ...(unreadCount === null
      ? {}
      : { badge: Math.min(Math.max(unreadCount, 0), BADGE_MAX) }),
  },
  [MOBILE_PUSH_DATA_KEY]: {
    v: MOBILE_PUSH_DATA_VERSION,
    kind: notification.kind,
    notificationId: notification.id,
    organizationId: notification.organizationId,
    workspaceId: notification.workspaceId,
    entityType: notification.entityType,
    entityId: notification.entityId,
  },
});
