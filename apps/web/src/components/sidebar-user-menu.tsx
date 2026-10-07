import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import {
  BuildingIcon,
  ChevronsUpDownIcon,
  CogIcon,
  GlobeIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "@stll/ui/icons";
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
} from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import { DevSidebarGroup } from "@/components/dev-sidebar-group";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import {
  sidebarIdentityTriggerClassName,
  SidebarMenuItem,
  useSidebarLayout,
} from "@/components/sidebar";
import { PALETTES, THEMES, useTheme } from "@/components/theme-provider";
import Tooltip from "@/components/tooltip";
import { UserIdentityAvatar } from "@/components/user-avatar";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useSignOut } from "@/hooks/use-sign-out";
import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import type { Role } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { getDisplayName } from "@/lib/get-display-name";
import { organizationListOptions } from "@/lib/organization/queries";
import { sanitizeHref } from "@/lib/sanitize-href";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

const CHANGELOG_URL = "https://stll.app/changelog";
const isDev = import.meta.env.DEV;

type SidebarUserMenuProps = {
  user: {
    activeOrganizationId: string;
    email: string;
    id: string;
    image: string | null | undefined;
    name: string | undefined;
  };
};

/** Sidebar footer block with the user avatar and account menu. Shared
 * between the workspace sidebar and the public law shell so the chrome
 * stays identical on both surfaces. */
export const SidebarUserMenu = ({ user }: SidebarUserMenuProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const sidebarLayout = useSidebarLayout();
  const isCollapsed = sidebarLayout === "rail";
  const { theme, setTheme, palette, setPalette } = useTheme();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const roleQuery = useChromeQuery(roleOptions);
  const roleView = useQueryView(roleQuery);
  useQueryViewError(roleView);
  const role = roleView.type === "items" ? roleView.items : undefined;

  const displayName = getDisplayName(user.name, user.email) ?? t("common.user");

  return (
    <SidebarMenuItem>
      <Menu>
        <Tooltip
          content={isCollapsed ? displayName : null}
          render={
            <MenuTrigger
              className={cn(
                sidebarIdentityTriggerClassName(sidebarLayout),
                "data-popup-open:bg-sidebar-accent",
              )}
            />
          }
          side="right"
        >
          <UserIdentityAvatar
            className="size-7 rounded-full"
            fallbackClassName="text-3xs"
            image={user.image}
            name={displayName}
          />
          {!isCollapsed && (
            <>
              <div className="flex min-w-0 flex-col justify-center">
                {user.name ? (
                  <>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <BidiText
                        as="span"
                        className="min-w-0 truncate text-sm font-medium"
                      >
                        {user.name}
                      </BidiText>
                      {role && (
                        <span className="bg-muted text-muted-foreground text-3xs inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-medium select-none">
                          {t(`organization.roles.${role}`)}
                        </span>
                      )}
                    </div>
                    {user.email && (
                      <BidiText
                        as="span"
                        className="text-muted-foreground truncate text-xs"
                        direction="ltr"
                      >
                        {user.email}
                      </BidiText>
                    )}
                  </>
                ) : (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <BidiText
                      as="span"
                      className="min-w-0 truncate text-sm font-medium"
                      direction={user.email ? "ltr" : "auto"}
                    >
                      {user.email || t("common.user")}
                    </BidiText>
                    {role && (
                      <span className="bg-muted text-muted-foreground text-3xs inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-medium select-none">
                        {t(`organization.roles.${role}`)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <ChevronsUpDownIcon className="ms-auto size-4 opacity-50" />
            </>
          )}
        </Tooltip>
        <MenuPopup align="end" className="w-56" side="top" sideOffset={8}>
          <OrganizationMenuSection
            activeOrganizationId={user.activeOrganizationId}
            role={role}
            userId={user.id}
          />
          <MenuItem
            onClick={() => {
              detached(
                navigate({
                  to: "/settings",
                }),
                "sidebar-user-menu.navigate",
              );
            }}
          >
            <CogIcon />
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
                    onClick={() =>
                      detached(setLang(langCode), "sidebar-user-menu.set-lang")
                    }
                    value={langCode}
                  >
                    {LANG_ENDONYMS[langCode]}
                  </MenuRadioItem>
                ))}
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
            className="text-foreground-ghost data-highlighted:text-foreground text-2xs min-h-0 px-2 pt-1.5 pb-1 tabular-nums"
            label={t("selfhost.viewReleaseNotes")}
            nativeButton={false}
            render={
              <a
                aria-label={t("selfhost.viewReleaseNotes")}
                href={sanitizeHref(CHANGELOG_URL)}
                rel="noreferrer"
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
};

type OrganizationMenuSectionProps = {
  activeOrganizationId: string;
  role: Role | undefined;
  userId: string;
};

/** Active organization block at the top of the user menu: a plain label for
 * single-organization users, a switcher sub-menu for everyone else.
 *
 * Owns the organization list query rather than taking it as a prop so the
 * sidebar reads the active organization and the switchable ones from one cache
 * entry, and therefore one `organization/list` request per route. */
const OrganizationMenuSection = ({
  activeOrganizationId,
  role,
  userId,
}: OrganizationMenuSectionProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const analytics = useAnalytics();
  const invalidateSession = useInvalidateSession();
  const organizationsQuery = useChromeQuery(organizationListOptions(userId));
  const organizationsView = useQueryView(organizationsQuery);
  useQueryViewError(organizationsView);
  const organizations =
    organizationsView.type === "items" ? organizationsView.items : undefined;

  const { isPending: isSwitchPending, mutate: switchOrganization } =
    useMutation({
      mutationFn: async (organizationId: string) => {
        const { error } = await authClient.organization.setActive({
          organizationId,
        });

        if (error) {
          throw toAuthClientError(error);
        }

        await invalidateSession.mutateAsync();
        await navigate({ to: "/", replace: true });
      },
      onError: (error) => {
        notifyUserError(error, t("errors.actionFailed"));
        analytics.captureError(error);
      },
    });

  const activeOrganization = organizations?.find(
    (organization) => organization.id === activeOrganizationId,
  );

  if (!(organizations && activeOrganization)) {
    return null;
  }

  if (organizations.length < 2) {
    return (
      <>
        <QueryViewFeedback view={organizationsView} />
        <MenuGroup>
          <MenuGroupLabel className="flex min-w-0 items-center gap-1.5 text-sm">
            <BidiText as="span" className="min-w-0 truncate">
              {activeOrganization.name}
            </BidiText>
            <OrganizationRoleBadge role={role} />
          </MenuGroupLabel>
        </MenuGroup>
        <MenuSeparator />
      </>
    );
  }

  return (
    <>
      <QueryViewFeedback view={organizationsView} />
      <MenuSub>
        <MenuSubTrigger>
          <BuildingIcon />
          <BidiText as="span" className="min-w-0 truncate">
            {activeOrganization.name}
          </BidiText>
          <OrganizationRoleBadge role={role} />
        </MenuSubTrigger>
        <MenuSubPopup>
          <MenuGroup>
            <MenuGroupLabel>
              {t("organization.switchOrganization")}
            </MenuGroupLabel>
            <MenuRadioGroup value={activeOrganizationId}>
              {organizations.map((organization) => (
                <MenuRadioItem
                  key={organization.id}
                  disabled={isSwitchPending}
                  onClick={() => {
                    if (organization.id !== activeOrganizationId) {
                      switchOrganization(organization.id);
                    }
                  }}
                  value={organization.id}
                >
                  <BidiText as="span" className="min-w-0 truncate">
                    {organization.name}
                  </BidiText>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuSubPopup>
      </MenuSub>
      <MenuSeparator />
    </>
  );
};

/** The signed-in user's role in the active organization. */
const OrganizationRoleBadge = ({ role }: { role: Role | undefined }) => {
  const t = useTranslations();

  if (!role) {
    return null;
  }

  return (
    <span className="bg-muted text-muted-foreground text-2xs inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-medium select-none">
      {t(`organization.roles.${role}`)}
    </span>
  );
};
