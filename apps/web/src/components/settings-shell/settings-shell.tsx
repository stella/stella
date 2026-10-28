import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ChevronDownIcon, KeyboardIcon } from "@stll/ui/icons";
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

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { settingsNavSections } from "@/components/settings-shell/settings-nav";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useKeyboardShortcutsDialogStore } from "@/lib/keyboard-shortcuts-dialog-store";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

const NAV_ITEM_CLASS = cn(
  "hover:bg-sidebar-accent/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden",
  "focus-visible:ring-ring focus-visible:ring-2",
);

type SettingsShellProps = {
  children: ReactNode;
};

/**
 * The settings area inside the app frame: account and organization pages
 * share this navigation, so moving between them never changes the frame.
 */
export const SettingsShell = ({ children }: SettingsShellProps) => {
  const t = useTranslations();
  const memoryEnabled = useCallerFeatureEnabled(CALLER_FEATURE.aiMemory);
  const timeBilling = useTimeBillingPreviewEnabled();
  const roleQuery = useQuery(roleOptions);
  const roleView = queryView(roleQuery);
  useQueryViewError(roleView, "SettingsShell.role:query");
  const role =
    roleView.type === "items" && roleView.refetchError === undefined
      ? roleView.items
      : undefined;
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const openShortcuts = useKeyboardShortcutsDialogStore((store) => store.open);
  const sections = settingsNavSections({
    role,
    memory:
      memoryEnabled &&
      role !== undefined &&
      authClient.organization.checkRolePermission({
        role,
        permissions: { chat: ["create"] },
      }),
    beta: betaFeaturesAvailable(),
    timeBilling,
  });

  const activeItem = sections
    .flatMap(({ items }) => items)
    .find(({ to }) => pathname === to || pathname.startsWith(`${to}/`));

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
                          to={item.to}
                          aria-current={
                            item === activeItem ? "page" : undefined
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
                      to={item.to}
                    >
                      <Icon className="size-4" />
                      <span>{t(item.labelKey)}</span>
                    </Link>
                  );
                })}
                {section.id === "account" && (
                  <button
                    className={NAV_ITEM_CLASS}
                    onClick={openShortcuts}
                    type="button"
                  >
                    <KeyboardIcon className="size-4" />
                    <span>{t("navigation.shortcutsDialog.title")}</span>
                  </button>
                )}
              </div>
            ))}
          </nav>
        </ScrollArea>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="flex min-w-0 flex-col">
          {/* One width for every page: organization tables need it, and
              moving between sections never shifts the content. */}
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
            <QueryViewFeedback view={roleView} />
            {children}
          </div>
        </main>
      </ScrollArea>
    </div>
  );
};
