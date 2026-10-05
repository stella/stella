import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ChevronDownIcon,
  BrainIcon,
  BanknoteIcon,
  ClockIcon,
  FlaskConicalIcon,
  GaugeIcon,
  HashIcon,
  KeyboardIcon,
  MonitorIcon,
  PlugIcon,
  ScrollTextIcon,
  ShieldIcon,
  SparklesIcon,
  TagsIcon,
  UserIcon,
  UsersIcon,
} from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/menu";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { env } from "@/env";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import type { TranslationKey } from "@/i18n/types";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useKeyboardShortcutsDialogStore } from "@/lib/keyboard-shortcuts-dialog-store";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";
import { pageTitle } from "@/lib/page-title";
import { isBillingSettingsAccessible } from "@/routes/_protected.settings/-components/organization/billing-settings.logic";

export const Route = createFileRoute("/_protected/settings")({
  head: () => ({
    meta: [{ title: pageTitle("common.settings") }],
  }),
  component: SettingsLayout,
});

type NavTo =
  | "/settings/account/profile"
  | "/settings/account/desktop"
  | "/settings/account/connections"
  | "/settings/account/memory"
  | "/settings/account/beta"
  | "/settings/organization/members"
  | "/settings/organization/matter-numbering"
  | "/settings/organization/number-series"
  | "/settings/organization/vat-rates"
  | "/settings/organization/billing"
  | "/settings/organization/time-policy"
  | "/settings/organization/document-types"
  | "/settings/organization/ai"
  | "/settings/organization/anonymization"
  | "/settings/organization/usage"
  | "/settings/organization/audit-logs";

type NavItem = {
  readonly to: NavTo;
  readonly labelKey: TranslationKey;
  readonly icon: LucideIcon;
};

type Section = {
  readonly id: "account" | "organization";
  readonly labelKey: TranslationKey;
  readonly items: readonly NavItem[];
};

const BETA_NAV_ITEM = {
  to: "/settings/account/beta",
  labelKey: "settings.account.beta",
  icon: FlaskConicalIcon,
} as const satisfies NavItem;

const ACCOUNT_SECTION = {
  id: "account",
  labelKey: "settings.account.title",
  items: [
    {
      to: "/settings/account/profile",
      labelKey: "common.profile",
      icon: UserIcon,
    },
    {
      to: "/settings/account/desktop",
      labelKey: "settings.account.desktop",
      icon: MonitorIcon,
    },
    {
      to: "/settings/account/connections",
      labelKey: "settings.connections.title",
      icon: PlugIcon,
    },
    {
      // Personal + firm + matter memory in one panel. Reachable by
      // every member (RLS scopes what they see); firm-library
      // creation is gated inside the panel by the firmMemory role.
      to: "/settings/account/memory",
      labelKey: "memory.pageTitle",
      icon: BrainIcon,
    },
    // Beta features: only on hosts where users may flip them (dev,
    // staging); appended conditionally in SettingsLayout.
  ],
} as const satisfies Section;

const ORGANIZATION_SECTION = {
  id: "organization",
  labelKey: "common.organization",
  items: [
    {
      to: "/settings/organization/members",
      labelKey: "common.members",
      icon: UsersIcon,
    },
    {
      to: "/settings/organization/number-series",
      labelKey: "billing.numberSeries.title",
      icon: HashIcon,
    },
    {
      to: "/settings/organization/vat-rates",
      labelKey: "billing.vatRates.title",
      icon: BanknoteIcon,
    },
    {
      to: "/settings/organization/billing",
      labelKey: "billing.settingsTitle",
      icon: BanknoteIcon,
    },
    {
      to: "/settings/organization/matter-numbering",
      labelKey: "settings.organization.matterNumbering",
      icon: HashIcon,
    },
    {
      to: "/settings/organization/time-policy",
      labelKey: "settings.organization.timePolicy.title",
      icon: ClockIcon,
    },
    {
      to: "/settings/organization/document-types",
      labelKey: "settings.organization.documentTypes.title",
      icon: TagsIcon,
    },
    {
      to: "/settings/organization/ai",
      labelKey: "settings.organization.ai",
      icon: SparklesIcon,
    },
    {
      to: "/settings/organization/anonymization",
      labelKey: "settings.organization.anonymization.title",
      icon: ShieldIcon,
    },
    {
      to: "/settings/organization/usage",
      labelKey: "settings.organization.usage",
      icon: GaugeIcon,
    },
    {
      to: "/settings/organization/audit-logs",
      labelKey: "settings.organization.auditLogs",
      icon: ScrollTextIcon,
    },
  ],
} as const satisfies Section;

const NAV_ITEM_CLASS = cn(
  "hover:bg-sidebar-accent/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden",
  "focus-visible:ring-ring focus-visible:ring-2",
);

function SettingsLayout() {
  const t = useTranslations();
  const { data: role } = useQuery({ ...roleOptions, throwOnError: true });
  const showOrganization = hasOrganizationManagementAccess(role);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const openShortcuts = useKeyboardShortcutsDialogStore((store) => store.open);
  const canUseMemory =
    env.VITE_FEATURE_AI_MEMORY &&
    role !== undefined &&
    authClient.organization.checkRolePermission({
      role,
      permissions: { chat: ["create"] },
    });
  const accountItems = ACCOUNT_SECTION.items.filter(
    (item) => item.to !== "/settings/account/memory" || canUseMemory,
  );

  // No `Section` annotation: it would widen labelKey to the full
  // TranslationKey union, whose ICU-variable members make t() demand a
  // values argument. The literal key types stay narrow this way.
  const accountSection = betaFeaturesAvailable()
    ? ({
        ...ACCOUNT_SECTION,
        items: [...accountItems, BETA_NAV_ITEM],
      } as const)
    : ({ ...ACCOUNT_SECTION, items: accountItems } as const);
  const timeBillingPreviewEnabled = useTimeBillingPreviewEnabled();
  const billingAccessible = isBillingSettingsAccessible({
    previewEnabled: timeBillingPreviewEnabled,
    role,
  });
  const organizationSection = {
    ...ORGANIZATION_SECTION,
    items: ORGANIZATION_SECTION.items.filter(
      (item) =>
        (item.to !== "/settings/organization/number-series" ||
          billingAccessible) &&
        (item.to !== "/settings/organization/vat-rates" || billingAccessible) &&
        (item.to !== "/settings/organization/billing" || billingAccessible) &&
        (item.to !== "/settings/organization/time-policy" ||
          timeBillingPreviewEnabled),
    ),
  };
  const sections = showOrganization
    ? [accountSection, organizationSection]
    : [accountSection];

  const activeItem = sections
    .map(({ items }) =>
      items.find(({ to }) => pathname === to || pathname.startsWith(`${to}/`)),
    )
    .find((item) => item !== undefined);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <div className="shrink-0 border-b p-3 md:hidden">
        <Menu>
          <MenuTrigger
            aria-label={t("common.settings")}
            render={
              <Button className="w-full justify-between" variant="outline" />
            }
          >
            <span className="truncate">
              {activeItem ? t(activeItem.labelKey) : t("common.settings")}
            </span>
            <ChevronDownIcon className="size-4 shrink-0" />
          </MenuTrigger>
          <MenuPopup align="start">
            {sections.map((section) => (
              <MenuGroup key={section.id}>
                <MenuGroupLabel>{t(section.labelKey)}</MenuGroupLabel>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <MenuItem
                      key={item.to}
                      render={
                        <Link
                          from={Route.fullPath}
                          to={item.to}
                          aria-current={
                            pathname === item.to ? "page" : undefined
                          }
                        />
                      }
                    >
                      <Icon className="size-4" />
                      {t(item.labelKey)}
                    </MenuItem>
                  );
                })}
                {section.id === "account" && (
                  <MenuItem onClick={openShortcuts}>
                    <KeyboardIcon className="size-4" />
                    {t("navigation.shortcutsDialog.title")}
                  </MenuItem>
                )}
              </MenuGroup>
            ))}
          </MenuPopup>
        </Menu>
      </div>
      <div className="bg-muted/30 hidden w-60 shrink-0 border-e md:block">
        <ScrollArea className="h-full">
          <nav
            aria-label={t("common.settings")}
            className="flex flex-col gap-4 p-3"
          >
            {sections.map((section) => (
              <div key={section.id} className="flex flex-col gap-1">
                <div className="text-muted-foreground px-2 py-1 text-xs font-medium tracking-wide uppercase">
                  {t(section.labelKey)}
                </div>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.to}
                      activeProps={{
                        className:
                          "bg-sidebar-accent text-sidebar-accent-foreground",
                      }}
                      className={NAV_ITEM_CLASS}
                      from={Route.fullPath}
                      to={item.to}
                    >
                      <Icon className="size-4" />
                      <span>{t(item.labelKey)}</span>
                    </Link>
                  );
                })}
                {section.id === "account" ? (
                  <button
                    className={NAV_ITEM_CLASS}
                    onClick={openShortcuts}
                    type="button"
                  >
                    <KeyboardIcon className="size-4" />
                    <span>{t("navigation.shortcutsDialog.title")}</span>
                  </button>
                ) : null}
              </div>
            ))}
          </nav>
        </ScrollArea>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="flex min-w-0 flex-col">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
            <Outlet />
          </div>
        </main>
      </ScrollArea>
    </div>
  );
}
