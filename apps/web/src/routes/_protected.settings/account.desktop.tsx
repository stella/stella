import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";
import {
  ClipboardListIcon,
  FileTextIcon,
  LockKeyholeIcon,
} from "@stll/ui/icons";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { env } from "@/env";
import { DesktopConnectionCard } from "@/features/desktop/desktop-connection-card";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/settings/account/desktop")({
  head: () => ({ meta: [{ title: pageTitle("settings.account.desktop") }] }),
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.account.desktop",
      to: "/settings/account/desktop",
    }),
  },
  component: DesktopPage,
});

function DesktopPage() {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();
  const shortcut = platform === "mac" ? "⌘ ⇧ V" : "Ctrl + Shift + V";

  return (
    <>
      <SettingsPageHeader
        description={t("settings.account.desktopDescription")}
        title={t("settings.account.desktop")}
      />
      <DesktopConnectionCard />
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
      {env.VITE_SELFHOST ? (
        <Frame>
          <FramePanel>
            <div className="space-y-1 p-1">
              <h2 className="text-sm font-medium">
                {t("settings.account.desktopSelfHostTitle")}
              </h2>
              <p className="text-muted-foreground max-w-2xl text-sm">
                {t("settings.account.desktopSelfHostDescription")}
              </p>
            </div>
          </FramePanel>
        </Frame>
      ) : null}
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
