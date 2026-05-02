import { buttonVariants } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { cn } from "@stll/ui/lib/utils";
import { AppleIcon, MonitorDownIcon } from "lucide-react";
import { useTranslations } from "use-intl";

const RELEASES_BASE =
  "https://github.com/stella/stella/releases/latest/download";
const WINDOWS_EXE_URL = `${RELEASES_BASE}/Stella-windows-x64-setup.exe`;
const WINDOWS_MSI_URL = `${RELEASES_BASE}/Stella-windows-x64.msi`;
const MACOS_DMG_URL = `${RELEASES_BASE}/Stella-macos-universal.dmg`;

type Platform = "mac" | "windows" | "other";

const detectPlatform = (): Platform => {
  if (typeof navigator === "undefined") {
    return "other";
  }
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) {
    return "mac";
  }
  if (ua.includes("win")) {
    return "windows";
  }
  return "other";
};

export const DesktopDownloadSection = () => {
  const t = useTranslations();
  const platform = detectPlatform();

  const primaryClass = cn(buttonVariants({ size: "lg" }), "w-fit");
  const secondaryClass =
    "text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline w-fit";
  const outlineClass = cn(
    buttonVariants({ size: "lg", variant: "outline" }),
    "w-fit",
  );

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("account.settings.desktopApp")}</FrameTitle>
        <FrameDescription>
          {t("account.settings.desktopAppDescription")}
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <div className="flex flex-col gap-3 p-4">
          {platform === "mac" && (
            <>
              <a className={primaryClass} href={MACOS_DMG_URL}>
                <AppleIcon />
                {t("account.settings.desktopDownloadMac")}
              </a>
              <a className={secondaryClass} href={WINDOWS_EXE_URL}>
                {t("account.settings.desktopDownloadOtherMac")}
              </a>
            </>
          )}
          {platform === "windows" && (
            <>
              <a className={primaryClass} href={WINDOWS_EXE_URL}>
                <MonitorDownIcon />
                {t("account.settings.desktopDownloadWindows")}
              </a>
              <a className={secondaryClass} href={WINDOWS_MSI_URL}>
                {t("account.settings.desktopDownloadOtherWindows")}
              </a>
            </>
          )}
          {platform === "other" && (
            <div className="flex flex-col gap-2">
              <a className={primaryClass} href={WINDOWS_EXE_URL}>
                <MonitorDownIcon />
                {t("account.settings.desktopDownloadWindows")}
              </a>
              <a className={outlineClass} href={MACOS_DMG_URL}>
                <AppleIcon />
                {t("account.settings.desktopDownloadMac")}
              </a>
            </div>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
};
