import type { ReactNode } from "react";

import { LabelFace, SwitchFace } from "@stll/ui/control-face";
import { FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import { SettingsCardPending } from "@/components/settings-card.pending";

/** The switch's row: the switch, then its caption, at the touch height. */
export const CHAT_NOTIFICATIONS_TOGGLE_ROW_CLASS =
  "flex min-h-11 flex-row items-center gap-2";

/** The chat notifications card (`ChatNotificationsCard`): header and panel. */
export const ChatNotificationsCardFrame = ({
  children,
}: {
  children: ReactNode;
}) => (
  <SettingsCardPending
    description="settings.account.chatNotificationsDescription"
    title="settings.account.chatNotifications"
  >
    <FramePanel>
      <div className="p-4">{children}</div>
    </FramePanel>
  </SettingsCardPending>
);

/**
 * The card in its pending phase: the switch's face, off, beside its caption
 * (whether this browser allows notifications is read once the page mounts).
 */
export const ChatNotificationsCardPending = () => (
  <ChatNotificationsCardFrame>
    <div className="flex flex-col items-start gap-2">
      <div className={CHAT_NOTIFICATIONS_TOGGLE_ROW_CLASS}>
        <SwitchFace />
        <LabelFace>
          <PendingText
            barClassName="w-40"
            id="settings.account.chatNotificationsToggle"
          />
        </LabelFace>
      </div>
    </div>
  </ChatNotificationsCardFrame>
);
