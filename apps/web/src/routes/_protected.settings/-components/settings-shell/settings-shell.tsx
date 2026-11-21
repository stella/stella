import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SESSION_SIGN_IN_REVIEW } from "@stll/api-contract/session-sign-ins";
import { Badge } from "@stll/ui/badge";
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
import { TruncatedText } from "@stll/ui/truncated-text";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { env } from "@/env";
import { useTimeBillingChromeEnabled } from "@/hooks/use-time-billing-preview";
import { useFormatter } from "@/i18n/formatting-context";
import { sessionSignInsOptions } from "@/lib/account/session-sign-ins";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useKeyboardShortcutsDialogStore } from "@/lib/keyboard-shortcuts-dialog-store";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { settingsNavSections } from "@/routes/_protected.settings/-components/settings-shell/settings-nav";
import {
  SETTINGS_NAV_CLASS,
  SETTINGS_NAV_ITEM_CLASS,
  SETTINGS_NAV_SECTION_CLASS,
  SETTINGS_NAV_SECTION_LABEL_CLASS,
  SettingsChromeScope,
  SettingsContent,
  SettingsShellLayout,
} from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

type SettingsShellProps = {
  children: ReactNode;
};

/**
 * The settings area inside the app frame: account and organization pages
 * share this navigation, so moving between them never changes the frame.
 * Its regions come from `SettingsShellLayout`, which a settings page's
 * pending view draws on a cold load before this shell mounts.
 */
export const SettingsShell = ({ children }: SettingsShellProps) => {
  const t = useTranslations();
  const memoryEnabled = useCallerFeatureEnabled(CALLER_FEATURE.aiMemory);
  const timeBilling = useTimeBillingChromeEnabled();
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
  const reviewCount = usePendingSignInReviewCount();
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
    usage: env.VITE_FEATURE_USAGE,
  });

  const activeItem = sections
    .flatMap(({ items }) => items)
    .find(({ to }) => pathname === to || pathname.startsWith(`${to}/`));

  return (
    <SettingsShellLayout
      mobileMenu={
        <Menu>
          <MenuTrigger
            aria-label={t("common.settings")}
            render={
              <Button className="w-full justify-between" variant="outline" />
            }
          >
            <TruncatedText>
              {activeItem ? t(activeItem.labelKey) : t("common.settings")}
            </TruncatedText>
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
                      {item.to === SECURITY_PATH && reviewCount > 0 && (
                        <SignInReviewBadge count={reviewCount} />
                      )}
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
      }
      nav={
        <ScrollArea className="h-full">
          <nav aria-label={t("common.settings")} className={SETTINGS_NAV_CLASS}>
            {sections.map((section) => (
              <div key={section.id} className={SETTINGS_NAV_SECTION_CLASS}>
                <div className={SETTINGS_NAV_SECTION_LABEL_CLASS}>
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
                      className={SETTINGS_NAV_ITEM_CLASS}
                      to={item.to}
                    >
                      <Icon className="size-4" />
                      <span>{t(item.labelKey)}</span>
                      {item.to === SECURITY_PATH && reviewCount > 0 && (
                        <SignInReviewBadge count={reviewCount} />
                      )}
                    </Link>
                  );
                })}
                {section.id === "account" && (
                  <Button
                    className="block w-full"
                    onClick={openShortcuts}
                    variant="plain"
                  >
                    <span className={SETTINGS_NAV_ITEM_CLASS}>
                      <KeyboardIcon className="size-4" />
                      <span>{t("navigation.shortcutsDialog.title")}</span>
                    </span>
                  </Button>
                )}
              </div>
            ))}
          </nav>
        </ScrollArea>
      }
    >
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <SettingsContent>
          {/* The role arrives with the app's shell; only a failed read
              speaks here, never a loading line above the page. */}
          {roleView.type !== "pending" && <QueryViewFeedback view={roleView} />}
          <SettingsChromeScope>{children}</SettingsChromeScope>
        </SettingsContent>
      </ScrollArea>
    </SettingsShellLayout>
  );
};

const SECURITY_PATH = "/settings/account/security";

/** How many sign-ins wait for the account holder's review. */
const usePendingSignInReviewCount = (): number => {
  const { id } = useAuthenticatedUser();
  // A failed read shows no badge; the security page offers the retry.
  const signIns = queryView(useQuery(sessionSignInsOptions(id)), {
    isEmpty: () => false,
  });
  useQueryViewError(signIns, "SettingsShell:signInReviews");
  return signIns.type === "items"
    ? signIns.items.filter(
        ({ review }) => review === SESSION_SIGN_IN_REVIEW.pending,
      ).length
    : 0;
};

const SignInReviewBadge = ({ count }: { count: number }) => {
  const t = useTranslations();
  const format = useFormatter();
  return (
    <Badge
      aria-label={t("settings.account.security.navReviewCount", { count })}
      className="ms-auto"
      tone="warning"
    >
      {format.number(count)}
    </Badge>
  );
};
