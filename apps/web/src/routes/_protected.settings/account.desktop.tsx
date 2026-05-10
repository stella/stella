import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { buttonVariants } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { cn } from "@stll/ui/lib/utils";

import {
  detectDesktopPlatform,
  MACOS_DMG_URL,
  WINDOWS_EXE_URL,
  WINDOWS_MSI_URL,
} from "@/lib/desktop-downloads";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/desktop")({
  component: DesktopPage,
});

function DesktopPage() {
  const t = useTranslations();
  const platform = detectDesktopPlatform();

  const primaryClass = cn(buttonVariants({ size: "lg" }), "w-fit");
  const secondaryClass =
    "text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline w-fit";
  const outlineClass = cn(
    buttonVariants({ size: "lg", variant: "outline" }),
    "w-fit",
  );

  return (
    <>
      <SettingsPageHeader
        description={t("settings.account.desktopDescription")}
        title={t("settings.account.desktop")}
      />
      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-3 p-1">
            {platform === "mac" && (
              <>
                <a className={primaryClass} href={MACOS_DMG_URL}>
                  {t("settings.account.desktopDownloadMac")}
                </a>
                <a className={secondaryClass} href={WINDOWS_EXE_URL}>
                  {t("settings.account.desktopDownloadOtherMac")}
                </a>
              </>
            )}
            {platform === "windows" && (
              <>
                <a className={primaryClass} href={WINDOWS_EXE_URL}>
                  {t("settings.account.desktopDownloadWindows")}
                </a>
                <a className={secondaryClass} href={WINDOWS_MSI_URL}>
                  {t("settings.account.desktopDownloadOtherWindows")}
                </a>
              </>
            )}
            {platform === "other" && (
              <div className="flex flex-col gap-2">
                <a className={primaryClass} href={WINDOWS_EXE_URL}>
                  {t("settings.account.desktopDownloadWindows")}
                </a>
                <a className={outlineClass} href={MACOS_DMG_URL}>
                  {t("settings.account.desktopDownloadMac")}
                </a>
              </div>
            )}
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}
