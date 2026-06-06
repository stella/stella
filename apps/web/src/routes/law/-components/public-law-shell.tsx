import { lazy, Suspense, useState } from "react";

import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { CircleUserRoundIcon, PanelLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@/components/sidebar";
import { StellaWordmark } from "@/components/stella-wordmark";
import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { usePublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import { HOTKEYS } from "@/lib/hotkeys";

const SignInDialog = lazy(async () => {
  const module = await import("@/components/auth/sign-in-dialog");
  return { default: module.SignInDialog };
});

const SearchDialog = lazy(async () => {
  const module = await import("@/components/search-dialog");
  return { default: module.SearchDialog };
});

export function PublicLawShell() {
  const authStatus = useClientAuthStatus();
  const [authRedirectTo, setAuthRedirectTo] = useState<string | null>(null);
  const requestAuth = (redirectTo: string) => {
    setAuthRedirectTo(redirectTo);
  };

  const shell = (
    <SidebarProvider>
      <PublicLawSidebar authStatus={authStatus} requestAuth={requestAuth} />
      <SidebarInset className="flex flex-col">
        <Outlet />
      </SidebarInset>
      {authRedirectTo !== null && (
        <Suspense fallback={null}>
          <SignInDialog
            onOpenChange={(open) => {
              if (!open) {
                setAuthRedirectTo(null);
              }
            }}
            open
            redirectTo={authRedirectTo}
          />
        </Suspense>
      )}
    </SidebarProvider>
  );

  if (authStatus.isAuthenticated) {
    return (
      <AuthenticatedUserProvider user={authStatus.user}>
        {shell}
      </AuthenticatedUserProvider>
    );
  }

  return shell;
}

function PublicLawSidebar({
  authStatus,
  requestAuth,
}: {
  authStatus: ReturnType<typeof useClientAuthStatus>;
  requestAuth: (redirectTo: string) => void;
}) {
  const t = useTranslations();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [searchOpen, setSearchOpen] = useState(false);
  const publicLawPreviewEnabled = usePublicLawPreviewEnabled();
  const primaryNavItems = getWorkspacePrimaryNavItems({
    includePublicLaw: publicLawPreviewEnabled,
  });

  const requestPrivateFeature = (redirectTo: string) => {
    if (authStatus.isAuthenticated) {
      return;
    }

    if (authStatus.status === "checking") {
      return;
    }

    requestAuth(redirectTo);
  };

  const openSearch = () => {
    if (authStatus.isAuthenticated) {
      setSearchOpen(true);
      return;
    }

    requestPrivateFeature(currentHref);
  };

  useHotkey(HOTKEYS.SEARCH, openSearch);

  return (
    <Sidebar className="border-sidebar-border/35" collapsible="icon">
      <SidebarHeader className="border-sidebar-border/35 h-12 border-b p-0">
        <div
          className={
            isCollapsed
              ? "flex h-full items-center justify-center"
              : "flex h-full items-center justify-between ps-3 pe-2"
          }
        >
          {!isCollapsed && <StellaWordmark className="h-5 w-auto" />}
          <Button
            className="text-muted-foreground size-7"
            onClick={toggleSidebar}
            size="icon"
            variant="ghost"
          >
            <PanelLeftIcon className="size-4" />
            <span className="sr-only">{t("navigation.toggleSidebar")}</span>
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {primaryNavItems.map((item) => {
              const Icon = item.icon;
              const label = t(item.labelKey);

              if (item.kind === "action") {
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      aria-label={label}
                      disabled={authStatus.status === "checking"}
                      onClick={openSearch}
                      tooltip={label}
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>
                      <kbd className="text-muted-foreground text-[0.625rem]">
                        {formatForDisplay(HOTKEYS.SEARCH)}
                      </kbd>
                    </SidebarMenuBadge>
                  </SidebarMenuItem>
                );
              }

              if (item.to === "/law/cases") {
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild tooltip={label}>
                      <Link
                        activeProps={{ "data-active": true }}
                        aria-label={label}
                        to={item.to}
                      >
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              }

              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    aria-label={label}
                    disabled={authStatus.status === "checking"}
                    onClick={() => {
                      if (authStatus.isAuthenticated) {
                        void navigate({ to: item.to });
                        return;
                      }
                      requestPrivateFeature(item.to);
                    }}
                    tooltip={label}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      {authStatus.status === "anonymous" && (
        <SidebarFooter className="group-data-[collapsible=icon]:p-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label={t("auth.signIn")}
                onClick={() => requestAuth("/law/cases")}
                tooltip={t("auth.signIn")}
              >
                <CircleUserRoundIcon />
                <span>{t("auth.signIn")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
      {authStatus.isAuthenticated && (
        <Suspense fallback={null}>
          <SearchDialog onOpenChange={setSearchOpen} open={searchOpen} />
        </Suspense>
      )}
    </Sidebar>
  );
}
