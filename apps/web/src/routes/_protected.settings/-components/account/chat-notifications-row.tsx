import { useSyncExternalStore } from "react";

import { useTranslations } from "use-intl";

import { SettingsRow, settingsRowIds } from "@stll/ui/settings";
import { stellaToast } from "@stll/ui/toast";

import { Switch } from "@/components/switch";
import {
  setChatTurnNotificationsEnabled,
  supportsChatTurnNotifications,
  useChatTurnNotificationsEnabled,
} from "@/features/chat/use-chat-turn-notifications";
import { detached } from "@/lib/detached";

const noopSubscribe = (_onStoreChange: () => void) => () => undefined;

const ROW_ID = "chat-notifications";

/** Per-browser opt-in for system notifications when a chat turn ends while
 *  the page is out of sight. */
export const ChatNotificationsRow = () => {
  const t = useTranslations();
  const ids = settingsRowIds(ROW_ID);
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
    <SettingsRow
      description={t("settings.account.chatNotificationsDescription")}
      disabled={!supported}
      footer={
        supported ? undefined : (
          <p className="text-muted-foreground text-xs">
            {t("settings.account.chatNotificationsUnsupported")}
          </p>
        )
      }
      id={ROW_ID}
      interaction="label"
      title={t("settings.account.chatNotifications")}
    >
      <Switch
        aria-describedby={ids.description}
        aria-labelledby={ids.label}
        checked={enabled}
        disabled={!supported}
        onCheckedChange={(next) => {
          detached(handleChange(next), "chat-notifications-row.toggle");
        }}
      />
    </SettingsRow>
  );
};
