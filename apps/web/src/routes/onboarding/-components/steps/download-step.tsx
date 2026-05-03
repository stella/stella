import { Button, buttonVariants } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import { AppleIcon, MonitorDownIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  detectDesktopPlatform,
  MACOS_DMG_URL,
  WINDOWS_EXE_URL,
  WINDOWS_MSI_URL,
} from "@/lib/desktop-downloads";

type DownloadStepProps = {
  onNext: () => void;
  onSkip: () => void;
};

export const DownloadStep = ({ onNext, onSkip }: DownloadStepProps) => {
  const t = useTranslations();
  const platform = detectDesktopPlatform();

  const primaryClass = cn(buttonVariants(), "w-full");
  const secondaryClass =
    "text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline self-center";

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.desktopTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("settings.account.desktopAppDescription")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {platform === "mac" && (
          <>
            <a className={primaryClass} href={MACOS_DMG_URL}>
              <AppleIcon />
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
              <MonitorDownIcon />
              {t("settings.account.desktopDownloadWindows")}
            </a>
            <a className={secondaryClass} href={WINDOWS_MSI_URL}>
              {t("settings.account.desktopDownloadOtherWindows")}
            </a>
          </>
        )}
        {platform === "other" && (
          <>
            <a className={primaryClass} href={WINDOWS_EXE_URL}>
              <MonitorDownIcon />
              {t("settings.account.desktopDownloadWindows")}
            </a>
            <a
              className={cn(buttonVariants({ variant: "outline" }), "w-full")}
              href={MACOS_DMG_URL}
            >
              <AppleIcon />
              {t("settings.account.desktopDownloadMac")}
            </a>
          </>
        )}
      </div>

      <p className="text-muted-foreground/60 mt-3 text-xs">
        {t("onboarding.desktopHint")}
      </p>

      <div className="mt-8 flex items-center justify-end gap-3">
        <Button onClick={onSkip} type="button" variant="ghost">
          {t("onboarding.skipStep")}
        </Button>
        <Button onClick={onNext} type="button">
          {t("onboarding.getStarted")}
        </Button>
      </div>
    </>
  );
};
