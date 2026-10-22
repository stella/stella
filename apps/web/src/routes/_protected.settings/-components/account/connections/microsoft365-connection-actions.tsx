import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ListGroupDescription } from "@stll/ui/list";

type Microsoft365ConnectionActionsProps = {
  connected: boolean;
  enabled: boolean;
  canManage: boolean;
  pending: boolean;
  onDisconnect: () => void;
  onDisable: () => void;
};

export const Microsoft365ConnectionActions = ({
  connected,
  enabled,
  canManage,
  pending,
  onDisconnect,
  onDisable,
}: Microsoft365ConnectionActionsProps) => {
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
