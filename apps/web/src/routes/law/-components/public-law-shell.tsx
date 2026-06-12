import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";

import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  CircleUserRoundIcon,
  MessageSquarePlusIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Avatar, AvatarFallback } from "@stll/ui/components/avatar";
import { Button } from "@stll/ui/components/button";
import { Separator } from "@stll/ui/components/separator";
import { cn } from "@stll/ui/lib/utils";

import { FeedbackDialog } from "@/components/feedback-dialog";
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
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar";
import { SidebarUserMenu } from "@/components/sidebar-user-menu";
import { StellaWordmark } from "@/components/stella-wordmark";
import Tooltip from "@/components/tooltip";
import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import {
  SIDE_RAIL_CONTAINER_CLASS,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";
import { HOTKEYS } from "@/lib/hotkeys";
import { isPublicLawRouteEnabled } from "@/lib/public-law-launch";

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
        <PublicLawTopBar />
        <Outlet />
      </SidebarInset>
      {!authStatus.isAuthenticated && (
        <PublicInspectorRail requestAuth={requestAuth} />
      )}
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
  // This shell is server-rendered; the localStorage-backed preview
  // toggle is browser-only and would mismatch hydration. The host/env
  // gate is isomorphic, and anyone rendering this shell passed it.
  const primaryNavItems = getWorkspacePrimaryNavItems({
    includePublicLaw: isPublicLawRouteEnabled(),
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
            <SidebarUserMenu user={authStatus.user} />
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
}

function PublicLawTopBar() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const caseNumber = useRouterState({
    select: (state) => {
      const loaderData = state.matches.at(-1)?.loaderData;
      if (
        loaderData !== null &&
        typeof loaderData === "object" &&
        "caseNumber" in loaderData &&
        typeof loaderData.caseNumber === "string"
      ) {
        return loaderData.caseNumber;
      }
      return null;
    },
  });

  return (
    <header className="bg-sidebar flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
      {isMobile && (
        <>
          <SidebarTrigger className="-ms-1" />
          <Separator className="me-2 h-4" orientation="vertical" />
        </>
      )}
      <nav
        aria-label={t("common.caseLaw")}
        className="flex min-w-0 items-center gap-1.5 text-sm"
      >
        <Link
          className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          to="/law/cases"
        >
          {t("common.caseLaw")}
        </Link>
        {caseNumber !== null && (
          <>
            <span className="text-foreground-placeholder">/</span>
            <span className="text-foreground truncate font-medium">
              {caseNumber}
            </span>
          </>
        )}
      </nav>
    </header>
  );
}

/** Anonymous twin of the inspector side rail: same geometry and chrome
 * as the authenticated rail, with every affordance routed to sign-in. */
function PublicInspectorRail({
  requestAuth,
}: {
  requestAuth: (redirectTo: string) => void;
}) {
  const t = useTranslations();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  const railButton = (icon: ReactNode, edgeClass: string) => (
    <div
      className={cn(
        "flex w-full shrink-0 items-center justify-center",
        edgeClass,
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <Tooltip
        content={t("inspector.openChat")}
        render={
          <button
            aria-label={t("inspector.openChat")}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center rounded-md transition-colors",
              SIDE_RAIL_ICON_BUTTON_SIZE,
            )}
            onClick={() => requestAuth(currentHref)}
            type="button"
          />
        }
      >
        {icon}
      </Tooltip>
    </div>
  );

  return (
    <div
      className="text-sidebar-foreground hidden md:block"
      data-side="right"
      data-state="collapsed"
    >
      <div className={cn("bg-sidebar relative", SIDE_RAIL_WIDTH)} />
      <div
        className={cn(
          "fixed inset-y-0 end-0 z-10 hidden h-svh md:flex",
          SIDE_RAIL_WIDTH,
        )}
      >
        <div className="bg-sidebar flex h-full w-full flex-col">
          <div className="bg-background flex h-full border-s shadow-lg">
            <div className={SIDE_RAIL_CONTAINER_CLASS}>
              {railButton(<PanelRightIcon className="size-4" />, "border-b")}
              <div className="flex-1" />
              {railButton(
                <MessageSquarePlusIcon className="size-4" />,
                "border-t",
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
