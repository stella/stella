import type { ReactNode } from "react";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { BellIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { REALTIME_EVENT_TYPE } from "@stll/api-contract";
import {
  NOTIFICATION_ENTITY_TYPE,
  NOTIFICATION_KIND,
} from "@stll/api-contract/notifications";
import type {
  NotificationEntityType,
  NotificationKind,
} from "@stll/api-contract/notifications";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/popover";
import { Separator } from "@stll/ui/separator";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
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
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const organizationId = useAuthenticatedUser().activeOrganizationId;

  const {
    data,
    error: listError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(notificationsOptions({ organizationId }));

  // The count travels with every page and is computed server-side, so it stays
  // right no matter how little history this client holds. A failed read is not
  // "nothing unread": the badge stays dark either way, so the error has to be
  // said out loud rather than rendered as the calm empty state.
  const unreadCount = data?.pages.at(0)?.unreadCount ?? 0;
  const items = data ? data.pages.flatMap((page) => page.items) : [];

  useUnreadFaviconDot(unreadCount > 0);

  useUserEventsSSE(organizationId, ({ type: eventType }) => {
    // The user channel carries a single event kind today; this bind makes a
    // second kind a compile error here instead of a silently ignored event.
    eventType satisfies typeof REALTIME_EVENT_TYPE.NEW_NOTIFICATION;
    detached(
      refetchFirstNotificationsPage({ organizationId, queryClient }),
      "notification-bell.refetch-first-page",
    );
  });

  useExternalSyncEffect(() => {
    if (listError === null) {
      return;
    }
    analytics.captureError(listError);
    stellaToast.error(
      userErrorFromThrown(listError, t("common.unexpectedError")),
    );
  }, [analytics, listError, t]);

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
    const requested = await Result.tryPromise(async () =>
      unwrapEden(
        await api
          .notifications({
            notificationId: toSafeId<"notification">(notification.id),
          })
          .read.patch(),
      ),
    );
    if (Result.isError(requested)) {
      reportFailure(requested.error);
      return;
    }
    await refetchFirstNotificationsPage({ organizationId, queryClient });
  };

  const markAllRead = async () => {
    const requested = await Result.tryPromise(async () =>
      unwrapEden(await api.notifications["read-all"].post()),
    );
    if (Result.isError(requested)) {
      reportFailure(requested.error);
      return;
    }
    await refetchFirstNotificationsPage({ organizationId, queryClient });
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
          <NotificationPanelBody
            items={items}
            listError={listError}
            onRead={(notification) => {
              detached(markRead(notification), "notification-bell.mark-read");
            }}
            onRetry={() => {
              detached(refetch(), "notification-bell.retry");
            }}
          />
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

type NotificationPanelBodyProps = {
  items: Notification[];
  listError: Error | null;
  onRead: (notification: Notification) => void;
  onRetry: () => void;
};

/**
 * The panel's three states, kept apart on purpose. A failed read renders as a
 * failure with a way out, never as the "you are all caught up" copy: the
 * reader would otherwise be told there is nothing waiting when the truth is
 * that nobody could look.
 */
const NotificationPanelBody = ({
  items,
  listError,
  onRead,
  onRetry,
}: NotificationPanelBodyProps) => {
  const t = useTranslations();

  if (listError !== null) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-3 px-3 py-6 text-center text-sm">
        <p>{userErrorFromThrown(listError, t("common.unexpectedError"))}</p>
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-6 text-center text-sm">
        {t("notifications.empty")}
      </p>
    );
  }

  return (
    <ul>
      {items.map((notification) => (
        <NotificationRow
          key={notification.id}
          notification={notification}
          onRead={() => {
            onRead(notification);
          }}
        />
      ))}
    </ul>
  );
};

type NotificationRowProps = {
  notification: Notification;
  onRead: () => void;
};

const NotificationRow = ({ notification, onRead }: NotificationRowProps) => {
  const unread = notification.readAt === null;
  const rowClassName = cn(
    "hover:bg-muted flex w-full items-start gap-2 px-3 py-2 text-start text-sm",
    unread && "font-medium",
  );
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          unread ? "bg-primary" : "bg-transparent",
        )}
      />
      <span className="min-w-0 flex-1">
        <NotificationMessage notification={notification} />
      </span>
    </>
  );
  const target = notificationTarget(notification);

  return (
    <li>
      {target === null ? (
        <button className={rowClassName} onClick={onRead} type="button">
          {body}
        </button>
      ) : (
        <NotificationLink
          className={rowClassName}
          onRead={onRead}
          target={target}
        >
          {body}
        </NotificationLink>
      )}
    </li>
  );
};

type NotificationTarget = {
  entityId: string;
  entityType: NotificationEntityType;
  workspaceId: string;
};

/**
 * The deep link this row can offer, or `null` when it cannot: an announcement
 * points at nothing, and a pointer whose matter has been deleted keeps its
 * message but loses its workspace. Every target route is
 * `/workspaces/$workspaceId/...`, so all three parts are required — a row
 * missing any of them renders as text rather than as a link that dead-ends.
 */
const notificationTarget = ({
  entityId,
  entityType,
  workspaceId,
}: Notification): NotificationTarget | null =>
  entityType === null || entityId === null || workspaceId === null
    ? null
    : { entityId, entityType, workspaceId };

type NotificationLinkProps = {
  children: ReactNode;
  className: string;
  onRead: () => void;
  target: NotificationTarget;
};

/**
 * Where each entity type opens. The switch is exhaustive over
 * `NotificationEntityType`, so a pointer shape added on the backend fails to
 * compile here instead of rendering an unclickable row.
 *
 * `PopoverClose` closes the panel as it navigates: the reader lands on the
 * target rather than on the target behind an open panel. Marking the row read
 * rides the same click, so following a notification is one gesture.
 */
const NotificationLink = ({
  children,
  className,
  onRead,
  target: { entityId, entityType, workspaceId },
}: NotificationLinkProps) => {
  switch (entityType) {
    // Today's only producer is a mention on a list item, and the item's own
    // id addresses no route: Lists is the surface the comment lives on.
    case NOTIFICATION_ENTITY_TYPE.ENTITY:
      return (
        <PopoverClose
          render={
            <Link
              className={className}
              onClick={onRead}
              params={{ workspaceId }}
              to="/workspaces/$workspaceId/lists"
            />
          }
        >
          {children}
        </PopoverClose>
      );
    case NOTIFICATION_ENTITY_TYPE.REPORT_EXPORT:
      return (
        <PopoverClose
          render={
            <Link
              className={className}
              onClick={onRead}
              params={{ exportId: entityId, workspaceId }}
              to="/workspaces/$workspaceId/reports/$exportId"
            />
          }
        >
          {children}
        </PopoverClose>
      );
    case NOTIFICATION_ENTITY_TYPE.FLOW_RUN:
      return (
        <PopoverClose
          render={
            <Link
              className={className}
              onClick={onRead}
              params={{ workspaceId }}
              search={{ run: entityId }}
              to="/workspaces/$workspaceId/workflows"
            />
          }
        >
          {children}
        </PopoverClose>
      );
    default:
      entityType satisfies never;
      return panic(`Unhandled entity type: ${String(entityType)}`);
  }
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
// A component rather than a helper taking `t`: annotating a parameter as
// `ReturnType<typeof useTranslations>` re-instantiates the whole message-tree
// generic per call and exceeds TypeScript's instantiation depth; the hook's
// inferred `t` does not. Parameterised branches pass literal keys for the
// same reason; NOTIFICATION_MESSAGE_KEY stays the totality gate.
// The return type is annotated, not inferred: React 19's `ReactNode` admits a
// promise, so `t.rich`'s inferred return reads as a maybe-async function.
const NotificationMessage = ({
  notification: { kind, metadata },
}: {
  notification: Notification;
}): ReactNode => {
  const t = useTranslations();
  // Every dynamic fragment below is somebody's name, a flow's name, or an
  // operator's title: user-authored text of unknown direction dropped into a
  // sentence whose direction comes from the UI locale. Without the isolate,
  // a Latin name inside an Arabic sentence drags neighbouring punctuation
  // across it. `bdi` is the tag the message declares; `BidiText` renders it.
  const bdi = (chunks: ReactNode) => <BidiText>{chunks}</BidiText>;
  switch (kind) {
    case NOTIFICATION_KIND.MENTION:
      return t.rich("notifications.kind.mention", {
        actorName: parameter(metadata, "actorName"),
        bdi,
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
      return t.rich("notifications.kind.flowRunCompleted", {
        bdi,
        flowName: parameter(metadata, "flowName"),
      });
    case NOTIFICATION_KIND.FLOW_RUN_FAILED:
      return t.rich("notifications.kind.flowRunFailed", {
        bdi,
        flowName: parameter(metadata, "flowName"),
      });
    case NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL:
      return t.rich("notifications.kind.flowRunAwaitingApproval", {
        bdi,
        flowName: parameter(metadata, "flowName"),
      });
    case NOTIFICATION_KIND.ANNOUNCEMENT:
      return t.rich("notifications.kind.announcement", {
        bdi,
        title: parameter(metadata, "title"),
      });
    default:
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
  }
};
