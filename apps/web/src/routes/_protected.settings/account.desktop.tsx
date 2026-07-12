import { useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { LinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { buttonVariants } from "@stll/ui/components/button-variants";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { env } from "@/env";
import { connectSelfHostedDesktop } from "@/lib/desktop-bridge";
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
  const webOrigin =
    typeof window === "undefined"
      ? env.VITE_PUBLIC_APP_URL
      : window.location.origin;
  const [selfHostConnectStatus, setSelfHostConnectStatus] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");

  const primaryClass = cn(buttonVariants({ size: "lg" }), "w-fit");
  const secondaryClass =
    "text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline w-fit";
  const outlineClass = cn(
    buttonVariants({ size: "lg", variant: "outline" }),
    "w-fit",
  );

  const handleConnectSelfHostedDesktop = async () => {
    setSelfHostConnectStatus("connecting");
    try {
      await connectSelfHostedDesktop({
        apiBaseUrl: env.VITE_API_URL,
        webOrigin,
      });
      setSelfHostConnectStatus("connected");
      stellaToast.add({
        title: t("common.done"),
        type: "success",
      });
    } catch {
      setSelfHostConnectStatus("error");
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    }
  };

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
      {env.VITE_SELFHOST && env.VITE_FEATURE_DESKTOP_EDITING && (
        <Frame>
          <FramePanel>
            <div className="flex flex-col gap-4 p-1">
              <div className="space-y-1">
                <h2 className="text-sm font-medium">
                  {t("settings.account.desktopSelfHostTitle")}
                </h2>
                <p className="text-muted-foreground max-w-2xl text-sm">
                  {t("settings.account.desktopSelfHostDescription")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  loading={selfHostConnectStatus === "connecting"}
                  onClick={() => {
                    void handleConnectSelfHostedDesktop();
                  }}
                  size="lg"
                >
                  <LinkIcon />
                  {t("common.connect")}
                </Button>
                <p className="text-muted-foreground text-sm">
                  {selfHostConnectStatus === "connecting" &&
                    t("common.loading")}
                  {selfHostConnectStatus === "connected" && t("common.done")}
                  {selfHostConnectStatus === "error" &&
                    t("errors.actionFailed")}
                </p>
              </div>
            </div>
          </FramePanel>
        </Frame>
      )}
    </>
  );
}
