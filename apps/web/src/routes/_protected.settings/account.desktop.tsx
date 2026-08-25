import { useState } from "react";

import { createFileRoute } from "@tanstack/react-router";
import {
  CheckIcon,
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
import { connectSelfHostedDesktop } from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/desktop")({
  component: DesktopPage,
});

function DesktopPage() {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();
  const [selfHostConnectStatus, setSelfHostConnectStatus] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");

  const shortcut = platform === "mac" ? "⌘ ⇧ V" : "Ctrl + Shift + V";
  const installStep =
    platform === "windows"
      ? t("settings.account.desktopInstallWindowsStep")
      : t("settings.account.desktopInstallMacStep");

  const handleConnectSelfHostedDesktop = async () => {
    setSelfHostConnectStatus("connecting");
    try {
      await connectSelfHostedDesktop({
        apiBaseUrl: externalApiOrigin(),
        webOrigin: window.location.origin,
      });
      setSelfHostConnectStatus("connected");
      stellaToast.add({
        title: t("common.done"),
        type: "success",
      });
    } catch (error) {
      getAnalytics().captureError(error);
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
      <Frame className="overflow-hidden">
        <FramePanel className="overflow-hidden p-0">
          <section className="relative isolate grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-center">
            <img
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-10 size-full opacity-25"
              src="/branding/onboarding-gradient-light.svg"
            />
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
          <section className="space-y-4">
            <h2 className="text-sm font-medium">
              {t("settings.account.desktopInstallTitle")}
            </h2>
            <ol className="grid gap-3 sm:grid-cols-2">
              {[installStep, t("settings.account.desktopInstallOpenStep")].map(
                (step) => (
                  <li
                    className="bg-muted/48 flex items-start gap-3 rounded-xl p-4 text-sm leading-relaxed"
                    key={step}
                  >
                    <span className="bg-foreground text-background mt-0.5 grid size-5 shrink-0 place-items-center rounded-full">
                      <CheckIcon aria-hidden="true" className="size-3" />
                    </span>
                    <span>{step}</span>
                  </li>
                ),
              )}
            </ol>
          </section>
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
                    detached(
                      handleConnectSelfHostedDesktop(),
                      "settings-account-desktop.connect-self-hosted-desktop",
                    );
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
