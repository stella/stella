import { MonitorIcon, PlugIcon, TerminalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

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
        {t("onboarding.appsTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.appsSubtitle")}
      </p>

      <div className="mt-8 flex flex-col gap-3">
        <div className="border-border rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <MonitorIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-foreground text-sm font-medium">
                {t("settings.account.desktop")}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("settings.account.desktopAppDescription")}
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-2">
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
              <>
                <a className={primaryClass} href={WINDOWS_EXE_URL}>
                  {t("settings.account.desktopDownloadWindows")}
                </a>
                <a
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "w-full",
                  )}
                  href={MACOS_DMG_URL}
                >
                  {t("settings.account.desktopDownloadMac")}
                </a>
              </>
            )}
          </div>

          <p className="text-foreground-muted mt-3 text-xs">
            {t("onboarding.desktopHint")}
          </p>
        </div>

        <div className="border-border rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <PlugIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-foreground text-sm font-medium">
                {t("settings.connections.mcpTitle")}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("onboarding.mcpCardDescription")}
              </p>
            </div>
          </div>
        </div>

        <div className="border-border rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <TerminalIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <h2 className="text-foreground text-sm font-medium">
                {t("settings.connections.cliTitle")}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {t("onboarding.cliCardDescription")}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-8">
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
