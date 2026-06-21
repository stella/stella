import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDaysIcon,
  CalendarIcon,
  ChevronsUpDownIcon,
  GlobeIcon,
  HashIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  Settings2Icon,
  SunIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { cn } from "@stll/ui/lib/utils";

import { DevSidebarGroup } from "@/components/dev-sidebar-group";
import { SidebarMenuItem, useSidebar } from "@/components/sidebar";
import { PALETTES, THEMES, useTheme } from "@/components/theme-provider";
import Tooltip from "@/components/tooltip";
import { useSignOut } from "@/hooks/use-sign-out";
import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { getInitials } from "@/lib/get-initials";
import { organizationOptions } from "@/routes/_protected.organization/-queries";

const CHANGELOG_URL = "https://stll.app/changelog";
const isDev = import.meta.env.DEV;

type SidebarUserMenuProps = {
  user: {
    email: string;
    image: string | null | undefined;
    name: string | undefined;
  };
};

/** Sidebar footer block with the user avatar and account menu. Shared
 * between the workspace sidebar and the public law shell so the chrome
 * stays identical on both surfaces. */
export function SidebarUserMenu({ user }: SidebarUserMenuProps) {
  const t = useTranslations();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const { state, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;
  const { theme, setTheme, palette, setPalette } = useTheme();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const calendar = useI18nStore((s) => s.calendar);
  const numberingSystem = useI18nStore((s) => s.numberingSystem);
  const setCalendar = useI18nStore((s) => s.setCalendar);
  const setNumberingSystem = useI18nStore((s) => s.setNumberingSystem);
  const weekStart = useI18nStore((s) => s.weekStart);
  const setWeekStart = useI18nStore((s) => s.setWeekStart);
  const { data: organization } = useQuery(organizationOptions);

  // "auto" resolves to a concrete value for the radio selection: Gregorian for
  // every locale, Eastern Arabic-Indic digits for Arabic and Western elsewhere.
  const activeCalendar = calendar === "auto" ? "gregory" : calendar;
  const autoNumbering = lang === "ar" ? "arab" : "latn";
  const activeNumbering =
    numberingSystem === "auto" ? autoNumbering : numberingSystem;

  const displayName = user.name ?? user.email;
  const orgName = organization?.name;

  return (
    <SidebarMenuItem>
      <Menu>
        <Tooltip
          content={isCollapsed ? displayName : null}
          render={
            <MenuTrigger
              className={cn(
                "hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent flex w-full items-center overflow-hidden rounded-md p-2 text-start text-sm outline-hidden",
                isCollapsed ? "justify-center" : "gap-2",
              )}
            />
          }
          side="right"
        >
          <Avatar className="size-7 rounded-full">
            {user.image && <AvatarImage src={user.image} />}
            <AvatarFallback className="text-[0.625rem]">
              {getInitials(displayName)}
            </AvatarFallback>
          </Avatar>
          {!isCollapsed && (
            <>
              <div className="flex min-w-0 flex-col justify-center">
                {user.name ? (
                  <>
                    <span className="truncate text-sm font-medium">
                      {user.name}
                    </span>
                    {user.email && (
                      <span className="text-muted-foreground truncate text-xs">
                        {user.email}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="truncate text-sm font-medium">
                    {user.email || t("common.user")}
                  </span>
                )}
              </div>
              <ChevronsUpDownIcon className="ms-auto size-4 opacity-50" />
            </>
          )}
        </Tooltip>
        <MenuPopup align="end" className="w-56" side="top" sideOffset={8}>
          {orgName && (
            <>
              <MenuGroup>
                <MenuGroupLabel className="text-sm">{orgName}</MenuGroupLabel>
              </MenuGroup>
              <MenuSeparator />
            </>
          )}
          <MenuItem
            onClick={() => {
              void navigate({
                to: "/settings",
              });
            }}
          >
            <Settings2Icon />
            {t("common.settings")}
          </MenuItem>
          <MenuSeparator />
          <MenuSub>
            <MenuSubTrigger>
              <SunIcon />
              {t("appearance.title")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuGroup>
                <MenuGroupLabel>{t("appearance.theme")}</MenuGroupLabel>
                <MenuRadioGroup value={theme}>
                  {THEMES.map((themeOption) => (
                    <MenuRadioItem
                      key={themeOption}
                      onClick={() => setTheme(themeOption)}
                      value={themeOption}
                    >
                      <div className="flex items-center gap-1.5">
                        {
                          {
                            light: <SunIcon />,
                            dark: <MoonIcon />,
                            system: <MonitorIcon />,
                          }[themeOption]
                        }
                        {t(`appearance.${themeOption}`)}
                      </div>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{t("appearance.palette")}</MenuGroupLabel>
                <MenuRadioGroup value={palette}>
                  {PALETTES.map((p) => (
                    <MenuRadioItem
                      key={p}
                      onClick={() => setPalette(p)}
                      value={p}
                    >
                      {t(`appearance.${p}`)}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>
              <GlobeIcon />
              {t("common.language")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup value={lang}>
                {supportedLanguages.map((langCode) => (
                  <MenuRadioItem
                    key={langCode}
                    onClick={() => void setLang(langCode)}
                    value={langCode}
                  >
                    {LANG_ENDONYMS[langCode]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>
              <CalendarIcon />
              {t("appearance.calendar")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup value={activeCalendar}>
                <MenuRadioItem
                  onClick={() => setCalendar("gregory")}
                  value="gregory"
                >
                  {t("appearance.calendarGregorian")}
                </MenuRadioItem>
                <MenuRadioItem
                  onClick={() => setCalendar("islamic-umalqura")}
                  value="islamic-umalqura"
                >
                  {t("appearance.calendarHijri")}
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>
              <HashIcon />
              {t("appearance.numbers")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup value={activeNumbering}>
                <MenuRadioItem
                  onClick={() => setNumberingSystem("latn")}
                  value="latn"
                >
                  {t("appearance.numbersWestern")}
                </MenuRadioItem>
                <MenuRadioItem
                  onClick={() => setNumberingSystem("arab")}
                  value="arab"
                >
                  {t("appearance.numbersEastern")}
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>
              <CalendarDaysIcon />
              {t("appearance.weekStart")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup value={weekStart}>
                <MenuRadioItem
                  onClick={() => setWeekStart("auto")}
                  value="auto"
                >
                  {t("appearance.weekStartAuto")}
                </MenuRadioItem>
                <MenuRadioItem
                  onClick={() => setWeekStart("saturday")}
                  value="saturday"
                >
                  {t("appearance.weekStartSaturday")}
                </MenuRadioItem>
                <MenuRadioItem
                  onClick={() => setWeekStart("sunday")}
                  value="sunday"
                >
                  {t("appearance.weekStartSunday")}
                </MenuRadioItem>
                <MenuRadioItem
                  onClick={() => setWeekStart("monday")}
                  value="monday"
                >
                  {t("appearance.weekStartMonday")}
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          {isDev && <DevSidebarGroup />}
          <MenuSeparator />
          <MenuItem
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <LogOutIcon />
            {t("common.signOut")}
          </MenuItem>
          <MenuItem
            aria-label={t("selfhost.viewReleaseNotes")}
            className="text-foreground-ghost data-highlighted:text-foreground min-h-0 px-2 pt-1.5 pb-1 text-[0.6875rem] tabular-nums"
            label={t("selfhost.viewReleaseNotes")}
            nativeButton={false}
            render={
              <a
                aria-label={t("selfhost.viewReleaseNotes")}
                href={CHANGELOG_URL}
                rel="noopener"
                target="_blank"
              />
            }
          >
            v{__APP_VERSION__} · {__APP_COMMIT_SHA__.slice(0, 12)}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
