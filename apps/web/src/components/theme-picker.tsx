import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/components/menu";

import { THEMES, useTheme } from "@/components/theme-provider";

const THEME_ICON = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
} as const;

export const ThemePicker = () => {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const t = useTranslations();
  const TriggerIcon = THEME_ICON[resolvedTheme];

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("appearance.theme")}
        className="text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors"
        render={<button type="button" />}
      >
        <TriggerIcon className="size-4" />
        {t(`appearance.${theme}`)}
      </MenuTrigger>
      <MenuPopup side="bottom">
        <MenuRadioGroup value={theme}>
          {THEMES.map((themeOption) => {
            const Icon = THEME_ICON[themeOption];
            return (
              <MenuRadioItem
                key={themeOption}
                onClick={() => setTheme(themeOption)}
                value={themeOption}
              >
                <div className="flex items-center gap-1.5">
                  <Icon className="size-4" />
                  {t(`appearance.${themeOption}`)}
                </div>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};
