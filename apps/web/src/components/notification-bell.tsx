import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { BellIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { REALTIME_EVENT_TYPE } from "@stll/api-contract";
import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import type { NotificationKind } from "@stll/api-contract/notifications";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  notificationsOptions,
  refetchFirstNotificationsPage,
} from "@/lib/notification-queries";
import type { Notification } from "@/lib/notification-queries";
import { toSafeId } from "@/lib/safe-id";
import { useUnreadFaviconDot } from "@/lib/unread-favicon-dot";
import { useUserEventsSSE } from "@/lib/user-events-sse";

/**
 * Unread awareness for the signed-in person: mentions, finished exports,
 * flow-run outcomes and announcements, read or unread and nothing else.
 * Deliberately not a work surface — anything with a deadline or an owner
 * belongs to My Work, not here.
 */
export const NotificationBell = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const organizationId = useAuthenticatedUser().activeOrganizationId;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(notificationsOptions({ organizationId }));

  // The count travels with every page and is computed server-side, so it stays
  // right no matter how little history this client holds.
  const unreadCount = data?.pages.at(0)?.unreadCount ?? 0;
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  useUnreadFaviconDot(unreadCount > 0);

  useUserEventsSSE(({ type: eventType }) => {
    switch (eventType) {
      case REALTIME_EVENT_TYPE.NEW_NOTIFICATION:
        detached(
          refetchFirstNotificationsPage({ organizationId, queryClient }),
          "notification-bell.refetch-first-page",
        );
        return;
      default:
        eventType satisfies never;
    }
  });

  const reportFailure = (error: unknown) => {
    stellaToast.add({
      title: userErrorFromThrown(error, t("errors.actionFailed")),
      type: "error",
    });
  };

  const markRead = async (notification: Notification) => {
    if (notification.readAt !== null) {
      return;
    }
    try {
      unwrapEden(
        await api
          .notifications({
            notificationId: toSafeId<"notification">(notification.id),
          })
          .read.patch(),
      );
      await refetchFirstNotificationsPage({ organizationId, queryClient });
    } catch (error) {
      reportFailure(error);
    }
  };

  const markAllRead = async () => {
    try {
      unwrapEden(await api.notifications["read-all"].post());
      await refetchFirstNotificationsPage({ organizationId, queryClient });
    } catch (error) {
      reportFailure(error);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={
              unreadCount > 0
                ? t("notifications.unreadLabel", { count: unreadCount })
                : t("notifications.title")
            }
            className="relative"
            size="icon-sm"
            title={t("notifications.title")}
            variant="ghost"
          />
        }
      >
        <BellIcon className="size-4" />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="bg-primary absolute end-1 top-1 size-1.5 rounded-full"
          />
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-88 p-0" side="bottom">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-medium">
            {t("notifications.title")}
          </span>
          {unreadCount > 0 && (
            <Button
              onClick={() => {
                detached(markAllRead(), "notification-bell.mark-all-read");
              }}
              size="sm"
              variant="ghost"
            >
              {t("notifications.markAllRead")}
            </Button>
          )}
        </div>
        <Separator />
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
              {t("notifications.empty")}
            </p>
          ) : (
            <ul>
              {items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onRead={() => {
                    detached(
                      markRead(notification),
                      "notification-bell.mark-read",
                    );
                  }}
                />
              ))}
            </ul>
          )}
          {hasNextPage && (
            <div className="px-3 py-2">
              <Button
                className="w-full"
                disabled={isFetchingNextPage}
                onClick={() => {
                  detached(fetchNextPage(), "notification-bell.next-page");
                }}
                size="sm"
                variant="ghost"
              >
                {t("notifications.loadOlder")}
              </Button>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
};

type NotificationRowProps = {
  notification: Notification;
  onRead: () => void;
};

const NotificationRow = ({ notification, onRead }: NotificationRowProps) => {
  const t = useTranslations();
  const unread = notification.readAt === null;

  return (
    <li>
      <button
        className={cn(
          "hover:bg-muted flex w-full items-start gap-2 px-3 py-2 text-start text-sm",
          unread && "font-medium",
        )}
        onClick={onRead}
        type="button"
      >
        <span
          aria-hidden
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            unread ? "bg-primary" : "bg-transparent",
          )}
        />
        <span className="min-w-0 flex-1">
          {notificationMessage(t, notification)}
        </span>
      </button>
    </li>
  );
};

/**
 * Kind to message. Total over `NotificationKind`, so a kind added on the
 * backend fails to compile here rather than rendering a raw enum value; and
 * every key is a literal, so the i18n extractor sees all of them.
 *
 * The message's ICU parameters are exactly the fields the kind's metadata
 * carries — that pairing is fixed in `@stll/api-contract/notifications`, so a
 * producer cannot send a parameter this message does not render.
 */
const NOTIFICATION_MESSAGE_KEY = {
  [NOTIFICATION_KIND.MENTION]: "notifications.kind.mention",
  [NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED]:
    "notifications.kind.reportExportSucceeded",
  [NOTIFICATION_KIND.REPORT_EXPORT_FAILED]:
    "notifications.kind.reportExportFailed",
  [NOTIFICATION_KIND.FLOW_RUN_COMPLETED]: "notifications.kind.flowRunCompleted",
  [NOTIFICATION_KIND.FLOW_RUN_FAILED]: "notifications.kind.flowRunFailed",
  [NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL]:
    "notifications.kind.flowRunAwaitingApproval",
  [NOTIFICATION_KIND.ANNOUNCEMENT]: "notifications.kind.announcement",
} as const satisfies Record<NotificationKind, TranslationKey>;

/**
 * The stored metadata reaches the client as a plain string map: the wire type
 * cannot carry the per-kind shape the producer wrote against. Read each
 * parameter by the name its message uses and coerce, so a row written by an
 * older or newer server renders a slightly emptier sentence instead of
 * throwing in the header.
 */
const parameter = (
  metadata: Notification["metadata"],
  name: string,
): string => {
  const value = metadata[name];
  return value === undefined ? "" : String(value);
};

/**
 * Render one notification. The switch is exhaustive over `NotificationKind`,
 * and every branch takes its key from the map above, so a new kind fails to
 * compile here as well as there.
 */
const notificationMessage = (
  t: ReturnType<typeof useTranslations>,
  { kind, metadata }: Notification,
): string => {
  switch (kind) {
    case NOTIFICATION_KIND.MENTION:
      return t(NOTIFICATION_MESSAGE_KEY[NOTIFICATION_KIND.MENTION], {
        actorName: parameter(metadata, "actorName"),
      });
    case NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED:
      return t(
        NOTIFICATION_MESSAGE_KEY[NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED],
      );
    case NOTIFICATION_KIND.REPORT_EXPORT_FAILED:
      return t(
        NOTIFICATION_MESSAGE_KEY[NOTIFICATION_KIND.REPORT_EXPORT_FAILED],
      );
    case NOTIFICATION_KIND.FLOW_RUN_COMPLETED:
      return t(NOTIFICATION_MESSAGE_KEY[NOTIFICATION_KIND.FLOW_RUN_COMPLETED], {
        flowName: parameter(metadata, "flowName"),
      });
    case NOTIFICATION_KIND.FLOW_RUN_FAILED:
      return t(NOTIFICATION_MESSAGE_KEY[NOTIFICATION_KIND.FLOW_RUN_FAILED], {
        flowName: parameter(metadata, "flowName"),
      });
    case NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL:
      return t(
        NOTIFICATION_MESSAGE_KEY[NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL],
        { flowName: parameter(metadata, "flowName") },
      );
    case NOTIFICATION_KIND.ANNOUNCEMENT:
      return t(NOTIFICATION_MESSAGE_KEY[NOTIFICATION_KIND.ANNOUNCEMENT], {
        title: parameter(metadata, "title"),
      });
    default:
      kind satisfies never;
      return "";
  }
};
