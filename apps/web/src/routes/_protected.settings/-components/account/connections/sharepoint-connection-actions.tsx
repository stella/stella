import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ListGroupDescription } from "@stll/ui/list";

type SharepointConnectionActionsProps = {
  connected: boolean;
  enabled: boolean;
  canManage: boolean;
  pending: boolean;
  onDisconnect: () => void;
  onDisable: () => void;
};

export const SharepointConnectionActions = ({
  connected,
  enabled,
  canManage,
  pending,
  onDisconnect,
  onDisable,
}: SharepointConnectionActionsProps) => {
  const t = useTranslations();
  return (
    <>
      {connected && (
        <Button disabled={pending} onClick={onDisconnect} variant="outline">
          {t("common.disconnect")}
        </Button>
      )}
      {canManage && enabled && (
        <Button disabled={pending} onClick={onDisable} variant="ghost">
          {t("settings.connections.microsoft365Disable")}
        </Button>
      )}
      <ListGroupDescription>
        {t("settings.connections.microsoft365RevokeHint")}
      </ListGroupDescription>
    </>
  );
};
