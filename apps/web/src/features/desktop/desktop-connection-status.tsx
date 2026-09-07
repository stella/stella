import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { env } from "@/env";
import type { DesktopConnectionState } from "@/features/desktop/desktop-connection-store.logic";

type DesktopConnectionStatusProps = {
  /** Omitted where the surface already offers its own connect control. */
  onRetry?: () => void;
  state: DesktopConnectionState;
};

/**
 * One status line for the desktop link, shared by onboarding and settings so
 * both surfaces describe the same automatic connection with the same words.
 */
export const DesktopConnectionStatus = ({
  onRetry,
  state,
}: DesktopConnectionStatusProps) => {
  const t = useTranslations();

  switch (state.status) {
    // Nothing has been downloaded on this visit, so there is nothing to say.
    case "idle":
      return null;
    case "waiting":
      // Self-hosted deployments cannot connect on their own: the app refuses
      // an origin it does not trust yet, so promising it would be a lie. Those
      // users start from the Connect button.
      return env.VITE_SELFHOST ? null : (
        <p className="text-muted-foreground text-sm">
          {t("settings.account.desktopAutoConnectHint")}
        </p>
      );
    case "connecting":
      return (
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      );
    case "connected":
      return (
        <p className="text-muted-foreground text-sm">
          {t.rich("settings.account.desktopConnectedAs", {
            bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
            email: state.email,
          })}
        </p>
      );
    case "error":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-sm">
            {t("settings.account.desktopConnectFailed")}
          </p>
          {onRetry && (
            <Button onClick={onRetry} size="xs" type="button" variant="link">
              {t("common.retry")}
            </Button>
          )}
        </div>
      );
    default: {
      state satisfies never;
      return panic(`Unhandled desktop connection status: ${String(state)}`);
    }
  }
};
