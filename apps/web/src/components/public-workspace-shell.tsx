import { lazy, Suspense, useState } from "react";
import type { ReactElement } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { CircleUserRoundIcon, PanelLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Avatar, AvatarFallback } from "@stll/ui/avatar";
import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";
import { WorkspaceShell } from "@stll/ui/workspace-shell";

import { FeedbackDialog } from "@/components/feedback-dialog";
import { PublicInspectorRail } from "@/components/public-inspector-rail";
import { PublicSignInRequestContext } from "@/components/public-sign-in-request";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
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
import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { getAnalytics } from "@/lib/analytics/provider";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import { formatHotkeyForPlatform, HOTKEYS } from "@/lib/hotkeys";
import { isPublicLawSsrRouteEnabled } from "@/lib/public-law-launch";
import { isPublicToolsRouteEnabled } from "@/lib/public-tools-launch";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";

const SignInDialog = lazy(async () => {
  const module = await import("@/components/auth/sign-in-dialog");
  return { default: module.SignInDialog };
});

const AppSidebar = lazy(async () => {
  const module = await import("@/components/app-sidebar");
  return { default: module.AppSidebar };
});

const CreateMatterDialog = lazy(async () => {
  const module = await import("@/components/workspaces/create-matter-dialog");
  return { default: module.CreateMatterDialog };
});

const SearchDialog = lazy(async () => {
  const module = await import("@/components/search-dialog");
  return { default: module.SearchDialog };
});

// Loaded lazily so its authed deps (the browser auth client via
// use-sign-out, and the organization query module) never enter the
// SSR-reachable graph of this public shell. It only renders client-side
// once auth resolves to authenticated.
const SidebarUserMenu = lazy(async () => {
  const module = await import("@/components/sidebar-user-menu");
  return { default: module.SidebarUserMenu };
});

// Routes reachable without authentication. Their nav entries render as
// real <Link>s (crawlable, no sign-in prompt); every other primary-nav
// destination routes anonymous users through the sign-in dialog.
const isPublicPrimaryNavRoute = (to: string): boolean =>
  to === "/law/cases" || to === "/tools";

type PublicWorkspaceShellProps = {
  /**
   * The surface's own inspector dock. It replaces the anonymous rail, so a
   * surface that supplies one owns the whole right column, sign-in
   * affordances included.
   */
  inspector?: ReactElement | undefined;
  topBar: ReactElement;
};

/**
 * Shared chrome for the public, selectively-SSR'd surfaces (`/law`,
 * `/tools`). Owns the sidebar, the anonymous inspector rail, the
 * sign-in round-trip, and the authenticated-user context; each surface
 * supplies its own breadcrumb `topBar`.
 */
export const PublicWorkspaceShell = ({
  inspector,
  topBar,
}: PublicWorkspaceShellProps) => {
  const authStatus = useClientAuthStatus();
  const createMatterDialogOpen = useCreateMatterStore(
    (state) => state.dialog.status === "open",
  );
  const [authRedirectTo, setAuthRedirectTo] = useState<string | null>(null);
  const requestAuth = (redirectTo: string) => {
    setAuthRedirectTo(redirectTo);
  };
  const navigate = useNavigate();
  const openChat = () => {
    if (!authStatus.isAuthenticated) {
      requestAuth("/chat/new");
      return;
    }

    navigate({ to: "/chat/new" }).catch((error: unknown) => {
      getAnalytics().captureError(error);
    });
  };

  const defaultInspector = <PublicInspectorRail onActivate={openChat} />;

  const shell = (
    <PublicSignInRequestContext value={requestAuth}>
      <SidebarProvider>
        <WorkspaceShell
          endDock={inspector ?? defaultInspector}
          navigation={{
            content: authStatus.isAuthenticated ? (
              <Suspense
                fallback={
                  <PublicSidebar
                    authStatus={authStatus}
                    requestAuth={requestAuth}
                  />
                }
              >
                <AppSidebar />
              </Suspense>
            ) : (
              <PublicSidebar
                authStatus={authStatus}
                requestAuth={requestAuth}
              />
            ),
            mode: "responsive",
          }}
          topBar={() => topBar}
        >
          <Outlet />
        </WorkspaceShell>
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
        {authStatus.isAuthenticated && createMatterDialogOpen && (
          <Suspense fallback={null}>
            <CreateMatterDialog />
          </Suspense>
        )}
      </SidebarProvider>
    </PublicSignInRequestContext>
  );

  if (authStatus.isAuthenticated) {
    return (
      <AuthenticatedUserProvider user={authStatus.user}>
        {shell}
      </AuthenticatedUserProvider>
    );
  }

  return shell;
};

const PublicSidebar = ({
  authStatus,
  requestAuth,
}: {
  authStatus: ReturnType<typeof useClientAuthStatus>;
  requestAuth: (redirectTo: string) => void;
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  const searchHotkeyLabel = formatHotkeyForPlatform(
    HOTKEYS.SEARCH,
    hotkeyPlatform,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  // This shell is server-rendered; the localStorage-backed preview
  // toggle is browser-only and would mismatch hydration. The host/env
  // gate is isomorphic, and anyone rendering this shell passed it.
  const primaryNavItems = getWorkspacePrimaryNavItems({
    includePublicLaw: isPublicLawSsrRouteEnabled(),
    includePublicTools: isPublicToolsRouteEnabled(),
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
    <Sidebar
      aria-label={t("navigation.toggleSidebar")}
      className="border-sidebar-border"
      collapsible="icon"
    >
      <SidebarHeader className="border-sidebar-border h-12 border-b p-0">
        <div
          className={cn(
            isCollapsed
              ? "flex h-full items-center justify-center"
              : "flex h-full items-center justify-between ps-3 pe-2",
          )}
        >
          {!isCollapsed && <StellaWordmark className="h-5 w-auto" />}
          <Button
            aria-label={t("navigation.toggleSidebar")}
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
                        {searchHotkeyLabel}
                      </kbd>
                    </SidebarMenuBadge>
                  </SidebarMenuItem>
                );
              }

              if (isPublicPrimaryNavRoute(item.to)) {
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
                        navigate({ to: item.to }).catch((error: unknown) => {
                          getAnalytics().captureError(error);
                        });
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
      <SidebarFooter>
        <SidebarMenu>
          <FeedbackDialog
            userEmail={
              authStatus.isAuthenticated ? authStatus.user.email : undefined
            }
          />
          {authStatus.status === "anonymous" && (
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label={t("auth.signIn")}
                className="h-auto gap-2 p-2"
                onClick={() => requestAuth(currentHref)}
                tooltip={t("auth.signIn")}
              >
                <Avatar className="size-7 rounded-full">
                  <AvatarFallback>
                    <CircleUserRoundIcon className="size-4" />
                  </AvatarFallback>
                </Avatar>
                <span>{t("auth.signIn")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {authStatus.isAuthenticated && (
            <Suspense fallback={null}>
              <SidebarUserMenu user={authStatus.user} />
            </Suspense>
          )}
        </SidebarMenu>
      </SidebarFooter>
      {authStatus.isAuthenticated && (
        <Suspense fallback={null}>
          <SearchDialog onOpenChange={setSearchOpen} open={searchOpen} />
        </Suspense>
      )}
    </Sidebar>
  );
};
