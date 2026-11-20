import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";

import { env } from "@/env";
import { DesktopConnectionCard } from "@/features/desktop/desktop-connection-card";
import { useHydrationSafeDesktopPlatform } from "@/hooks/use-hydration-safe-desktop-platform";
import { DesktopPageShell } from "@/routes/_protected.settings/-account.desktop.pending";

/** The desktop page: its shell (`DesktopPageShell`) with the live card. */
export function DesktopPage() {
  const t = useTranslations();
  const platform = useHydrationSafeDesktopPlatform();
  const shortcut = platform === "mac" ? "⌘ ⇧ V" : "Ctrl + Shift + V";

  return (
    <DesktopPageShell
      connectionCard={<DesktopConnectionCard />}
      shortcut={shortcut}
    >
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
    </DesktopPageShell>
  );
}
