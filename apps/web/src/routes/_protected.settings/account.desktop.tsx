import { useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  ClipboardListIcon,
  FileTextIcon,
  LinkIcon,
  LockKeyholeIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import { stellaToast } from "@stll/ui/toast";

import { DesktopDownloadButtons } from "@/components/desktop-download-buttons";
import { env } from "@/env";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import {
  connectSelfHostedDesktop,
  linkDesktopAccount,
} from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/desktop")({
  component: DesktopPage,
});

function DesktopPage() {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();
  const [connectStatus, setConnectStatus] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");

  const shortcut = platform === "mac" ? "⌘ ⇧ V" : "Ctrl + Shift + V";

  const handleConnectDesktop = async () => {
    setConnectStatus("connecting");
    try {
      const apiBaseUrl = externalApiOrigin();
      if (env.VITE_SELFHOST) {
        await connectSelfHostedDesktop({
          apiBaseUrl,
          webOrigin: window.location.origin,
        });
      }

      const linkedAccount = await getFreshLinkedAccount();
      if (!linkedAccount) {
        panic("Protected desktop settings did not have a linked account.");
      }

      await linkDesktopAccount({ apiBaseUrl, linkedAccount });
      setConnectStatus("connected");
      stellaToast.add({
        title: t("common.done"),
        type: "success",
      });
    } catch (error) {
      getAnalytics().captureError(error);
      setConnectStatus("error");
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
      <Frame className="overflow-hidden">
        <FramePanel className="overflow-hidden p-0">
          <section className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-center">
            <div className="flex max-w-2xl flex-col items-start">
              <h2 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
                {t("settings.account.desktopHeroTitle")}
              </h2>
              <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed text-pretty">
                {t("settings.account.desktopAppDescription")}
              </p>
              <div className="mt-6">
                <DesktopDownloadButtons platform={platform} size="lg" />
              </div>
            </div>

            <div className="bg-background/72 border-border/60 flex flex-col items-center rounded-2xl border px-5 py-6 text-center shadow-lg/5 backdrop-blur-xl">
              <span className="bg-primary/10 text-primary grid size-11 place-items-center rounded-2xl">
                <ClipboardListIcon aria-hidden="true" className="size-5" />
              </span>
              <p className="mt-3 text-sm font-medium">
                {t("settings.account.desktopClipboardTitle")}
              </p>
              <kbd
                className="bg-muted border-border mt-3 rounded-lg border px-3 py-1.5 font-mono text-xs shadow-xs"
                dir="ltr"
              >
                {shortcut}
              </kbd>
              <p className="text-muted-foreground mt-3 text-xs leading-relaxed text-pretty">
                {t("settings.account.desktopClipboardDescription")}
              </p>
            </div>
          </section>
        </FramePanel>

        <FramePanel className="grid gap-4 sm:grid-cols-2">
          <DesktopFeature
            description={t("settings.account.desktopPrivacyDescription")}
            icon={LockKeyholeIcon}
            title={t("settings.account.desktopPrivacyTitle")}
          />
          <DesktopFeature
            description={t("settings.account.desktopDocumentsDescription")}
            icon={FileTextIcon}
            title={t("settings.account.desktopDocumentsTitle")}
          />
        </FramePanel>
      </Frame>
      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-4 p-1">
            <div className="space-y-1">
              <h2 className="text-sm font-medium">
                {env.VITE_SELFHOST
                  ? t("settings.account.desktopSelfHostTitle")
                  : t("settings.account.desktop")}
              </h2>
              <p className="text-muted-foreground max-w-2xl text-sm">
                {env.VITE_SELFHOST
                  ? t("settings.account.desktopSelfHostDescription")
                  : t("settings.account.desktopDescription")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                loading={connectStatus === "connecting"}
                onClick={() => {
                  detached(
                    handleConnectDesktop(),
                    "settings-account-desktop.connect-desktop",
                  );
                }}
                size="lg"
              >
                <LinkIcon />
                {t("common.connect")}
              </Button>
              <p className="text-muted-foreground text-sm">
                {connectStatus === "connecting" && t("common.loading")}
                {connectStatus === "connected" && t("common.done")}
                {connectStatus === "error" && t("errors.actionFailed")}
              </p>
            </div>
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}

type DesktopFeatureProps = {
  description: string;
  icon: typeof ClipboardListIcon;
  title: string;
};

const DesktopFeature = ({
  description,
  icon: Icon,
  title,
}: DesktopFeatureProps) => (
  <section className="flex items-start gap-3 rounded-xl p-1">
    <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-xl">
      <Icon aria-hidden="true" className="size-4" />
    </span>
    <div className="min-w-0">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed text-pretty">
        {description}
      </p>
    </div>
  </section>
);
