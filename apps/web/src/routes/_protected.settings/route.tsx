import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import {
  GaugeIcon,
  HashIcon,
  MonitorIcon,
  ShieldIcon,
  SparklesIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import type { TranslationKey } from "@/i18n/types";
import { pageTitle } from "@/lib/page-title";
import { roleOptions } from "@/routes/-queries";
import { managementRoles } from "@/routes/_protected.organization/-consts";

export const Route = createFileRoute("/_protected/settings")({
  head: () => ({
    meta: [{ title: pageTitle("common.settings") }],
  }),
  component: SettingsLayout,
});

type NavTo =
  | "/settings/account/profile"
  | "/settings/account/desktop"
  | "/settings/organization/members"
  | "/settings/organization/matter-numbering"
  | "/settings/organization/ai"
  | "/settings/organization/anonymization"
  | "/settings/organization/usage";

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

const ACCOUNT_SECTION = {
  id: "account",
  labelKey: "settings.account.title",
  items: [
    {
      to: "/settings/account/profile",
      labelKey: "settings.account.profile",
      icon: UserIcon,
    },
    {
      to: "/settings/account/desktop",
      labelKey: "settings.account.desktop",
      icon: MonitorIcon,
    },
  ],
} as const satisfies Section;

const ORGANIZATION_SECTION = {
  id: "organization",
  labelKey: "common.organization",
  items: [
    {
      to: "/settings/organization/members",
      labelKey: "navigation.members",
      icon: UsersIcon,
    },
    {
      to: "/settings/organization/matter-numbering",
      labelKey: "settings.organization.matterNumbering",
      icon: HashIcon,
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
  ],
} as const satisfies Section;

function SettingsLayout() {
  const t = useTranslations();
  const { data: role } = useSuspenseQuery(roleOptions);
  const showOrganization = managementRoles.includes(role);

  const sections = showOrganization
    ? [ACCOUNT_SECTION, ORGANIZATION_SECTION]
    : [ACCOUNT_SECTION];

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden border-t">
      <nav
        aria-label={t("common.settings")}
        className="bg-muted/30 flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-e p-3"
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
                  className={cn(
                    "hover:bg-sidebar-accent/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden",
                    "focus-visible:ring-ring focus-visible:ring-2",
                  )}
                  to={item.to}
                >
                  <Icon className="size-4" />
                  <span>{t(item.labelKey)}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
