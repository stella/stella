import type { SafeId } from "@/api/lib/branded-types";
import {
  desktopEditSessionClosedEvent,
  desktopEditSessionCloseSignal,
} from "@/api/lib/desktop-edit-session-notifications";
import type { SSEEvent } from "@/api/lib/sse-broadcast";

export type ExpiredDesktopEditSessionNotification = {
  id: SafeId<"desktopEditSession">;
  workspaceId: SafeId<"workspace">;
};

export type DesktopEditSessionExpiryNotificationPublisher = {
  publishSessionEvent: (
    sessionId: SafeId<"desktopEditSession">,
    event: SSEEvent,
  ) => Promise<void>;
  publishWorkspaceEvent: (
    workspaceId: SafeId<"workspace">,
    event: SSEEvent,
  ) => Promise<void>;
};

export const publishDesktopEditSessionExpiryNotifications = async ({
  publisher,
  sessions,
}: {
  publisher: DesktopEditSessionExpiryNotificationPublisher;
  sessions: ExpiredDesktopEditSessionNotification[];
}): Promise<void> => {
  const workspaceIds = new Set(sessions.map((session) => session.workspaceId));
  const sessionNotifications = sessions.map(async (session) => {
    await publisher.publishSessionEvent(
      session.id,
      desktopEditSessionClosedEvent("expired"),
    );
    await publisher.publishSessionEvent(
      session.id,
      desktopEditSessionCloseSignal(),
    );
  });
  const workspaceNotifications: Promise<void>[] = [];
  for (const workspaceId of workspaceIds) {
    workspaceNotifications.push(
      publisher.publishWorkspaceEvent(workspaceId, {
        type: "invalidate-query",
        data: ["entities", workspaceId],
      }),
    );
  }

  await Promise.all([...sessionNotifications, ...workspaceNotifications]);
};
