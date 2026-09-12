import { createFileRoute } from "@tanstack/react-router";
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
import { DesktopConnectionStatus } from "@/features/desktop/desktop-connection-status";
import { useDesktopAccountConnection } from "@/features/desktop/use-desktop-account-connection";
import { useMountEffect } from "@/hooks/use-effect";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { isDesktopAccountLink } from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/desktop")({
  component: DesktopPage,
});

function DesktopPage() {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();
  // Downloading the app starts a watch that links it as soon as it runs; the
  // button below is the manual path and shares the same attempt, so the two
  // cannot link twice.
  const { connect, startWatch, state } = useDesktopAccountConnection();

  const shortcut = platform === "mac" ? "⌘ ⇧ V" : "Ctrl + Shift + V";

  const handleConnectDesktop = async () => {
    const outcome = await connect();
    stellaToast.add(
      outcome.status === "connected"
        ? { title: t("common.done"), type: "success" }
        : { title: t("errors.actionFailed"), type: "error" },
    );
  };
  // The desktop app opens this page with an account-link marker; a
  // signed-in session completes the connection without another click.
  useMountEffect(() => {
    if (isDesktopAccountLink(window.location.hash)) {
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      detached(handleConnectDesktop(), "settings-account-desktop.handoff");
    }
  });

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
                <DesktopDownloadButtons
                  onDownload={startWatch}
                  platform={platform}
                  size="lg"
                />
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
                loading={state.status === "connecting"}
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
              <DesktopConnectionStatus state={state} />
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
