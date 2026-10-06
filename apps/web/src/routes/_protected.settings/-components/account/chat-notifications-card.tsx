import { useId, useSyncExternalStore } from "react";

import { useTranslations } from "use-intl";

import { Field, FieldDescription, FieldLabel } from "@stll/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { stellaToast } from "@stll/ui/toast";

import { Switch } from "@/components/switch";
import {
  setChatTurnNotificationsEnabled,
  supportsChatTurnNotifications,
  useChatTurnNotificationsEnabled,
} from "@/features/chat/use-chat-turn-notifications";
import { detached } from "@/lib/detached";

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
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("settings.account.chatNotifications")}</FrameTitle>
        <FrameDescription>
          {t("settings.account.chatNotificationsDescription")}
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <div className="flex flex-col gap-2 p-4">
          <Field className="min-h-11 flex-row items-center gap-2">
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
          </Field>
          {!supported && (
            <FieldDescription>
              {t("settings.account.chatNotificationsUnsupported")}
            </FieldDescription>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
};
