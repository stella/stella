import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import type { DesktopConnectionState } from "@/features/desktop/desktop-connection-store.logic";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";

type DesktopConnectionStatusProps = {
  /** Omitted where the surface already offers its own connect control. */
  onRetry?: () => void;
  state: DesktopConnectionState;
};

/**
 * One status line for the desktop link, shared by onboarding and settings so
 * both surfaces describe the connection with the same words.
 */
export const DesktopConnectionStatus = ({
  onRetry,
  state,
}: DesktopConnectionStatusProps) => {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();

  switch (state.status) {
    case "idle":
      return null;
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
    case "update-required":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            {t("workspaces.files.desktopEdit.updateRequiredTitle")}
          </p>
          <DesktopDownloadButtons platform={platform} />
        </div>
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
