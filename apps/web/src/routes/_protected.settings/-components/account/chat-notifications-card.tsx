import { useId, useSyncExternalStore } from "react";

import { useTranslations } from "use-intl";

import { Field, FieldDescription, FieldLabel } from "@stll/ui/field";
import { stellaToast } from "@stll/ui/toast";

import { Switch } from "@/components/switch";
import {
  setChatTurnNotificationsEnabled,
  supportsChatTurnNotifications,
  useChatTurnNotificationsEnabled,
} from "@/features/chat/use-chat-turn-notifications";
import { detached } from "@/lib/detached";
import {
  CHAT_NOTIFICATIONS_TOGGLE_ROW_CLASS,
  ChatNotificationsCardFrame,
} from "@/routes/_protected.settings/-components/account/chat-notifications-card.pending";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

/** Per-browser opt-in for system notifications when a chat turn ends while
 *  the page is out of sight. */
export const ChatNotificationsCard = () => {
  const t = useTranslations();
  const id = useId();
  const enabled = useChatTurnNotificationsEnabled();
  const supported = useSyncExternalStore(
    noopSubscribe,
    supportsChatTurnNotifications,
    () => false,
  );

  const handleChange = async (next: boolean) => {
    const outcome = await setChatTurnNotificationsEnabled(next);
    if (outcome === "denied") {
      stellaToast.add({
        title: t("settings.account.chatNotificationsBlocked"),
        type: "warning",
      });
    }
  };

  return (
    <ChatNotificationsCardFrame>
      {/* The description belongs to the field, so it is announced with
          the switch; a browser without notifications explains why here. */}
      <Field className="gap-2">
        <div className={CHAT_NOTIFICATIONS_TOGGLE_ROW_CLASS}>
          <Switch
            checked={enabled}
            disabled={!supported}
            id={id}
            onCheckedChange={(next) => {
              detached(handleChange(next), "chat-notifications-card.toggle");
            }}
          />
          <FieldLabel htmlFor={id}>
            {t("settings.account.chatNotificationsToggle")}
          </FieldLabel>
        </div>
        {!supported && (
          <FieldDescription>
            {t("settings.account.chatNotificationsUnsupported")}
          </FieldDescription>
        )}
      </Field>
    </ChatNotificationsCardFrame>
  );
};
