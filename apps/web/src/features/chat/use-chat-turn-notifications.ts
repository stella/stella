import { useRef } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  CHAT_TURN_NOTIFICATIONS_STORAGE_KEY,
  getChatTurnNotification,
} from "@/features/chat/turn-notifications.logic";
import type {
  ChatTurnNotificationKind,
  ChatTurnPhase,
} from "@/features/chat/turn-notifications.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLocalStorageFlag } from "@/hooks/use-local-storage-flag";
import type { TranslationKey } from "@/i18n/types";
import { logDevError } from "@/lib/errors/telemetry";

const NOTIFICATION_TEXT = {
  failed: {
    body: "chat.turnNotification.failedBody",
    title: "chat.turnNotification.failedTitle",
  },
  "needs-input": {
    body: "chat.turnNotification.needsInputBody",
    title: "chat.turnNotification.needsInputTitle",
  },
  "reply-ready": {
    body: "chat.turnNotification.replyReadyBody",
    title: "chat.turnNotification.replyReadyTitle",
  },
} as const satisfies Record<
  ChatTurnNotificationKind,
  { body: TranslationKey; title: TranslationKey }
>;

/** Whether this browser can show system notifications at all. */
export const supportsChatTurnNotifications = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

/** Turns the opt-in on or off for this browser. Turning it on asks for the
 *  browser's permission first and stays off when it is not granted. */
export const setChatTurnNotificationsEnabled = async (
  enabled: boolean,
): Promise<"denied" | "off" | "on" | "unsupported"> => {
  if (!supportsChatTurnNotifications()) {
    return "unsupported";
  }
  if (enabled) {
    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    if (permission !== "granted") {
      return "denied";
    }
  }
  const written = Result.try(() => {
    if (enabled) {
      localStorage.setItem(CHAT_TURN_NOTIFICATIONS_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(CHAT_TURN_NOTIFICATIONS_STORAGE_KEY);
    }
  });
  if (Result.isError(written)) {
    return "unsupported";
  }
  // `storage` events reach other tabs only; this tab's readers listen too.
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: CHAT_TURN_NOTIFICATIONS_STORAGE_KEY,
      storageArea: localStorage,
    }),
  );
  return enabled ? "on" : "off";
};

/** The opt-in as stored in this browser, with the permission still held. */
export const useChatTurnNotificationsEnabled = (): boolean => {
  const stored = useLocalStorageFlag(CHAT_TURN_NOTIFICATIONS_STORAGE_KEY);
  return (
    stored &&
    supportsChatTurnNotifications() &&
    Notification.permission === "granted"
  );
};

const isPageInSight = (): boolean =>
  document.visibilityState === "visible" && document.hasFocus();

/**
 * Tells the user, through a system notification, when a turn they left
 * running ends while the page is out of sight: answered, waiting on them,
 * or failed. One notification per thread at a time (`tag`), so a thread
 * open in two panes does not notify twice; clicking it brings the page
 * back.
 */
export const useChatTurnNotifications = ({
  conversationId,
  phase,
}: {
  conversationId: string;
  phase: ChatTurnPhase;
}) => {
  const t = useTranslations();
  const enabled = useChatTurnNotificationsEnabled();
  const lastSeenRef = useRef<{
    conversationId: string;
    phase: ChatTurnPhase;
  } | null>(null);

  useExternalSyncEffect(() => {
    const lastSeen = lastSeenRef.current;
    lastSeenRef.current = { conversationId, phase };
    if (!enabled) {
      return;
    }
    const kind = getChatTurnNotification({
      current: phase,
      pageVisible: isPageInSight(),
      previous:
        lastSeen?.conversationId === conversationId ? lastSeen.phase : null,
    });
    if (kind === null) {
      return;
    }
    const text = NOTIFICATION_TEXT[kind];
    // Some mobile browsers expose `Notification` but refuse the constructor;
    // a missed notification is all that costs.
    const shown = Result.try(() => {
      const notification = new Notification(t(text.title), {
        body: t(text.body),
        tag: `stella-chat-${conversationId}`,
      });
      notification.addEventListener("click", () => {
        window.focus();
        notification.close();
      });
    });
    if (Result.isError(shown)) {
      logDevError(shown.error);
    }
  }, [conversationId, enabled, phase, t]);
};
