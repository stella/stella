import { DownloadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { buttonVariants } from "@stll/ui/button-variants";
import { cn } from "@stll/ui/utils";

import {
  MACOS_DMG_URL,
  type DesktopPlatform,
  WINDOWS_EXE_URL,
  WINDOWS_MSI_URL,
} from "@/lib/desktop-downloads";
import { sanitizeHref } from "@/lib/sanitize-href";

type DesktopDownloadButtonsProps = {
  platform: DesktopPlatform;
  size?: "default" | "lg";
};

export const DesktopDownloadButtons = ({
  platform,
  size = "default",
}: DesktopDownloadButtonsProps) => {
  const t = useTranslations();
  const primaryClass = cn(buttonVariants({ size }), "w-full sm:w-fit");
  const outlineClass = cn(
    buttonVariants({ size, variant: "outline" }),
    "w-full sm:w-fit",
  );
  const secondaryClass =
    "text-muted-foreground hover:text-foreground w-fit text-sm underline-offset-2 hover:underline";

  if (platform === "mac") {
    return (
      <div className="flex flex-col items-start gap-2">
        <a className={primaryClass} href={sanitizeHref(MACOS_DMG_URL)}>
          <DownloadIcon />
          {t("settings.account.desktopDownloadMac")}
        </a>
        <a className={secondaryClass} href={sanitizeHref(WINDOWS_EXE_URL)}>
          {t("settings.account.desktopDownloadOtherMac")}
        </a>
      </div>
    );
  }

  if (platform === "windows") {
    return (
      <div className="flex flex-col items-start gap-2">
        <a className={primaryClass} href={sanitizeHref(WINDOWS_EXE_URL)}>
          <DownloadIcon />
          {t("settings.account.desktopDownloadWindows")}
        </a>
        <a className={secondaryClass} href={sanitizeHref(WINDOWS_MSI_URL)}>
          {t("settings.account.desktopDownloadOtherWindows")}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row">
      <a className={primaryClass} href={sanitizeHref(WINDOWS_EXE_URL)}>
        <DownloadIcon />
        {t("settings.account.desktopDownloadWindows")}
      </a>
      <a className={outlineClass} href={sanitizeHref(MACOS_DMG_URL)}>
        <DownloadIcon />
        {t("settings.account.desktopDownloadMac")}
      </a>
    </div>
  );
};
