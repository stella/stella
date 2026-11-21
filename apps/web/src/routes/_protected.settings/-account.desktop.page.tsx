import { useTranslations } from "use-intl";

import { SettingsRow, SettingsSection } from "@stll/ui/settings";

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
        <SettingsSection>
          <SettingsRow
            description={t("settings.account.desktopSelfHostDescription")}
            title={t("settings.account.desktopSelfHostTitle")}
          />
        </SettingsSection>
      ) : null}
    </DesktopPageShell>
  );
}
