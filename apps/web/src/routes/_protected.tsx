import { lazy, Suspense, useCallback, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import {
  CogIcon,
  MessageSquarePlusIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  INSPECTOR_RAIL_WIDTH,
  InspectorDock,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
  useInspectorPaneWidth,
} from "@stll/ui/inspector";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Separator } from "@stll/ui/separator";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";
import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/toast";
import { useViewportWidth } from "@stll/ui/use-viewport-width";
import { cn } from "@stll/ui/utils";
import { WorkspaceEndRail } from "@stll/ui/workspace-shell";
import { WorkspaceFrame } from "@stll/workspace-ui/workspace-frame";

import { ApiVersionMismatchBanner } from "@/components/api-version-mismatch-banner";
import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { DragAndDropLiveRegion } from "@/components/drag-and-drop-live-region";
import {
  initializeInspectorTabBroadcast,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { NotificationBell } from "@/components/notification-bell";
import { AIAvailabilityProvider } from "@/components/require-ai-key";
import { SelfhostUpdateBanner } from "@/components/selfhost-update-banner";
import { ShortcutEchoHud } from "@/components/shortcut-echo-hud";
import {
  SidebarProvider,
  SidebarToggleHotkey,
  SidebarTrigger,
  useSidebar,
  useSidebarInlineSize,
} from "@/components/sidebar";
import { CreateMatterDialog } from "@/components/workspaces/create-matter-dialog";
import { useGlobalChatMentionRegistration } from "@/features/chat/hooks/use-global-chat-mention-registration";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  isInboxPreviewEnabled,
  useInboxPreviewEnabled,
} from "@/hooks/use-inbox-preview";
import { useI18nStore } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import { ChromeHeaderActionsSlot } from "@/lib/chrome-header-actions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { resolveMatterColor } from "@/lib/matter-colors";
import { notificationsOptions } from "@/lib/notification-queries";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { usePinnedStore } from "@/lib/pinned-store";
import {
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";
import { workspaceOptions } from "@/lib/workspaces/queries";
import { loadAuthContext } from "@/routes/-auth-context";
import { shouldForceSidebarCollapsed } from "@/routes/-inspector-pane-width";

const MEMORY_ROUTE_PATH = "/settings/account/memory";

const LazyInspectorPanel = lazy(
  async () =>
    await import("@/components/inspector/inspector-panel").then((m) => ({
      default: m.InspectorPanel,
    })),
);

// Visual shell for the inspector rail while the panel chunk is
// loading. Mirrors the real rail's chrome (top toggle, bottom
// "new chat") so the rail doesn't render as an empty strip during
// the lazy chunk fetch. Buttons are inert; they activate once the
// real panel mounts.
const InspectorRailFallback = () => {
  const t = useTranslations();

  return (
    <div className="bg-background flex h-full border-s shadow-lg">
      <WorkspaceEndRail
        chatAction={{
          label: t("chat.newChat"),
          reason: t("common.loading"),
          status: "unavailable",
        }}
        className="h-full"
        label={t("inspector.title")}
        topAction={
          <span
            aria-hidden="true"
            className={cn(
              "text-muted-foreground flex items-center justify-center",
              SIDE_RAIL_ICON_BUTTON_SIZE,
            )}
          >
            <PanelRightIcon className="size-4" />
          </span>
        }
      />
    </div>
  );
};

const MobileInspectorFallback = () => (
  <div className="bg-background flex h-full min-w-0 flex-col">
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-3",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-4 flex-1" />
      <Skeleton className="size-7 rounded-md" />
    </div>
    <div className="space-y-3 px-4 py-4">
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  </div>
);

export const Route = createFileRoute("/_protected")({
  ssr: false,
  beforeLoad: async ({ context, location }) => {
    const authContext = await loadAuthContext(context.queryClient);

    if (!authContext.session || !authContext.user) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
      });
    }

    if (!authContext.session.activeOrganizationId) {
      throw redirect({ to: "/auth/organization", replace: true });
    }

    const activeOrganizationId = authContext.session.activeOrganizationId;

    // These shell queries only gate optional affordances. AI config stays
    // non-blocking. The role cache MUST be settled before chrome that reads it
    // via a non-suspense useQuery mounts (app-sidebar, inspector): a cold-cache
    // role fetch resolving mid-mount triggers React's "state update on a
    // not-yet-mounted component" warning, which the route-smoke e2e treats as a
    // failure. We therefore settle the role before chrome mounts: normally in
    // this parent, or in the memory child while it primes that route's panel
    // data. The prefetch is non-throwing, so a role-fetch failure resolves it
    // rather than stalling or taking down the shell.
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };
    detached(
      prefetchRouteQuery(
        context.queryClient,
        aiAvailabilityOptions({ organizationId: activeOrganizationId }),
        onPrefetchError,
      ),
      "protected-layout.prefetch",
    );
    // Prefetched here so the bell's first page joins the shell's request wave
    // instead of chaining a new sequential round after hydration.
    if (isInboxPreviewEnabled()) {
      detached(
        prefetchNonCriticalInfiniteQuery(
          context.queryClient,
          notificationsOptions({ organizationId: activeOrganizationId }),
          onPrefetchError,
        ),
        "protected-layout.notifications-prefetch",
      );
    }
    const rolePrefetch = prefetchRouteQuery(
      context.queryClient,
      roleOptions,
      onPrefetchError,
    );
    if (location.pathname === MEMORY_ROUTE_PATH) {
      // The child settles this same in-flight query together with its panel
      // data before chrome can mount, keeping all three requests in one wave.
      detached(rolePrefetch, "protected-layout.role-prefetch");
    } else {
      await rolePrefetch;
    }

    // Seed the pinned-matters store from localStorage before the
    // sidebar renders. The store's `init` is idempotent (skips when
    // the same userId is already loaded), so re-runs on navigation
    // cost nothing and a render-time effect is unnecessary.
    usePinnedStore.getState().init(authContext.session.userId);

    return {
      user: {
        id: authContext.session.userId,
        activeOrganizationId,
        name: authContext.user.name || undefined,
        email: authContext.user.email,
        image: authContext.user.image,
        preferredName: authContext.user.preferredName,
        timezoneId: authContext.user.timezoneId,
        wordEditShortcut: authContext.user.wordEditShortcut,
      },
    };
  },
  component: ProtectedComponent,
  // This subtree is private and client-only. Rendering a loading
  // shell in SSR gives no SEO value and previously tripped React's
  // streamed Suspense boundary path under Bun in CI, so the fallback
  // must stay PURE STATIC: plain layout divs + Skeleton blocks, no
  // hooks, context, data, lazy(), or Suspense. It renders identically
  // on server and client to shape the shell during hydration instead
  // of flashing a blank white screen.
  pendingComponent: ProtectedPendingSkeleton,
});

// Static, SSR-safe placeholder for the client-only `_protected`
// subtree. Mirrors the real shell's shape (left side-rail → sidebar
// column → main content with a header bar) using the same layout
// constants so the skeleton lines up with the chrome that replaces
// it. Intentionally free of hooks, context, data, and Suspense.
function ProtectedPendingSkeleton() {
  return (
    <div aria-hidden="true" className="bg-background flex h-full min-h-dvh">
      {/* Sidebar column — matches AppSidebar's 16rem width with a
          header row, a few stacked nav rows, and a footer row. */}
      <div className="bg-sidebar hidden w-64 shrink-0 flex-col gap-2 border-e p-2 md:flex">
        <div
          className={cn("flex shrink-0 items-center gap-2", TOOLBAR_ROW_HEIGHT)}
        >
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton className="h-8 w-full rounded-md" key={index} />
          ))}
        </div>
        <div className="flex-1" />
        <Skeleton className="h-8 w-full shrink-0 rounded-md" />
      </div>

      {/* Main content column — header-height bar + a handful of
          content blocks. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 border-b px-4",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className="h-4 w-40" />
          <div className="ms-auto flex items-center gap-2">
            <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
            <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-4 p-6">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-40 w-full rounded-md" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      </div>

      {/* Right side-rail — same width as the real rail with muted
          icon-sized blocks top and bottom. */}
      <div
        className={cn(
          "bg-muted/50 hidden shrink-0 flex-col border-s md:flex",
          SIDE_RAIL_WIDTH,
        )}
      >
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-b",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
        </div>
        <div className="flex-1" />
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-t",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
        </div>
      </div>
    </div>
  );
}

function ProtectedComponent() {
  const analyticsUser = Route.useRouteContext({ select: (ctx) => ctx.user });
  const inspectorBroadcastUserId = Route.useRouteContext({
    select: (ctx) => ctx.user.id,
  });
  const inspectorBroadcastOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const activeWorkspaceId = workspaceMatch?.params.workspaceId;
  const inspectorPaneOpen = useInspectorTabsStore(
    (state) => state.tabs.length > 0 && !state.minimized,
  );
  const viewportWidth = useViewportWidth();
  const forceSidebarCollapsed = shouldForceSidebarCollapsed({
    inspectorPaneOpen,
    viewportWidth,
  });

  useExternalSyncEffect(
    () =>
      initializeInspectorTabBroadcast({
        organizationId: inspectorBroadcastOrganizationId,
        userId: inspectorBroadcastUserId,
      }),
    [inspectorBroadcastOrganizationId, inspectorBroadcastUserId],
  );

  // Mod+J — toggles the inspector pane. With tabs already open it
  // restores or hides the pane regardless of route, so users can
  // minimise inside a matter and reopen from anywhere. With no
  // tabs the action becomes "open a fresh chat", which is only
  // meaningful inside a matter (we need somewhere to scope the
  // chat to); on non-workspace routes it's a no-op.
  const handleToggleInspectorHotkey = useCallback(() => {
    const store = useInspectorTabsStore.getState();
    if (store.tabs.length > 0) {
      store.toggleMinimized();
      return;
    }
    if (activeWorkspaceId) {
      store.openChat({
        workspaceId: activeWorkspaceId,
        contextMatterIds: [activeWorkspaceId],
      });
    }
  }, [activeWorkspaceId]);
  useHotkey(useEffectiveHotkey("toggleChat"), handleToggleInspectorHotkey);

  return (
    <AuthenticatedUserProvider user={analyticsUser}>
      <SidebarProvider forceCollapsed={forceSidebarCollapsed}>
        <SidebarToggleHotkey />
        <ChatMentionProviders>
          <AIAvailabilityProvider>
            <ChatEditorProvider>
              <GlobalChatMentionRegistration />
              <DragAndDropLiveRegion />
              <WorkspaceFrame
                composition="host-responsive"
                endDock={<WorkspaceInspectorSidePanel />}
                navigation={{ content: <AppSidebar />, mode: "responsive" }}
                topBar={() => <ProtectedContent />}
              >
                <Outlet />
              </WorkspaceFrame>
              <CreateMatterDialog />
              <ShortcutEchoHud />
              <KeyboardShortcutsDialog />
            </ChatEditorProvider>
          </AIAvailabilityProvider>
        </ChatMentionProviders>
      </SidebarProvider>
    </AuthenticatedUserProvider>
  );
}

function GlobalChatMentionRegistration() {
  useGlobalChatMentionRegistration();

  return null;
}

function ProtectedContent() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const togglePin = usePinnedStore((s) => s.togglePin);
  const pinnedIds = usePinnedStore((s) => s.pinnedIds);
  const projectMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const workspaceId = projectMatch?.params.workspaceId;
  const isPinned = workspaceId ? pinnedIds.has(workspaceId) : false;
  // Not mounting the bell is the whole gate: it is the only consumer of the
  // notifications query and of the user event stream.
  const inboxPreviewEnabled = useInboxPreviewEnabled();

  // Inspector toggle wiring — the right-side `PanelRightIcon`
  // button is the universal entry point for the inspector pane.
  // It's available everywhere (workspace, knowledge, dashboards),
  // not just inside a matter, so users can pop a minimised pane
  // back open from any route. Inside a workspace it doubles as
  // "create new chat" when no tabs are open yet.
  const inspectorMinimized = useInspectorTabsStore((s) => s.minimized);
  const inspectorTabsCount = useInspectorTabsStore((s) => s.tabs.length);
  const toggleInspector = useInspectorTabsStore((s) => s.toggleMinimized);
  const openInspectorChat = useInspectorTabsStore((s) => s.openChat);
  const openMatterInspector = useInspectorTabsStore((s) => s.openMatter);
  const handleInspectorButtonClick = () => {
    if (inspectorTabsCount === 0) {
      // No tabs yet — open a new chat. With a matter context the
      // chat is workspace-scoped and seeded with that matter's
      // contextMatterIds; outside a matter we open a global chat.
      openInspectorChat(
        workspaceId === undefined
          ? {}
          : { workspaceId, contextMatterIds: [workspaceId] },
      );
      return;
    }
    toggleInspector();
  };
  // Desktop keeps the rail mounted once tabs exist, so the rail is
  // the restore affordance. Mobile has no rail; after Back minimizes
  // the sheet, the chrome button must reappear so the user can return.
  const canShowInspectorButton =
    inspectorTabsCount === 0 || (isMobile && inspectorMinimized);
  const inspectorButtonTitle = (() => {
    if (inspectorTabsCount === 0) {
      return t("inspector.openChat");
    }
    if (inspectorMinimized) {
      return t("inspector.showPane");
    }
    return t("inspector.hidePane");
  })();

  // Right-clicking the chrome's icon row (including the empty
  // space after the last icon) offers a quick "Open new chat"
  // shortcut without forcing a trip to the inspector toggle.
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const chatMenuAnchorRef = useRef<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
  const handleIconRowContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    chatMenuAnchorRef.current = {
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    };
    setChatMenuOpen(true);
  };
  const handleOpenNewChatFromMenu = () => {
    openInspectorChat(
      workspaceId === undefined
        ? {}
        : { workspaceId, contextMatterIds: [workspaceId] },
    );
    setChatMenuOpen(false);
  };

  const { data: workspace } = useChromeQuery({
    ...workspaceOptions(workspaceId ?? ""),
    enabled: !!workspaceId,
  });
  const matterColor = workspaceId
    ? resolveMatterColor(workspaceId, workspace?.color ?? null)
    : null;
  const chromeActions = (
    <div
      className="ms-auto flex shrink-0 items-center gap-0.5"
      onContextMenu={handleIconRowContextMenu}
    >
      {workspaceId && (
        <>
          <Button
            onClick={() => togglePin(workspaceId)}
            size="icon-sm"
            title={isPinned ? t("common.unpin") : t("common.pin")}
            variant="ghost"
          >
            {isPinned ? (
              <PinOffIcon className="size-4" />
            ) : (
              <PinIcon className="size-4" />
            )}
          </Button>
          <Button
            onClick={() => {
              openMatterInspector({
                workspaceId,
                label: workspace?.name ?? t("workspaces.matterInfo"),
                color: workspace?.color ?? null,
              });
            }}
            size="icon-sm"
            title={t("workspaces.matterInfo")}
            variant="ghost"
          >
            <CogIcon className="size-4" />
          </Button>
        </>
      )}
      {inboxPreviewEnabled && <NotificationBell />}
      {canShowInspectorButton && (
        <div className="contents md:hidden">
          <Separator className="mx-1 h-4" orientation="vertical" />
          <Button
            className="size-7"
            onClick={handleInspectorButtonClick}
            size="icon"
            title={inspectorButtonTitle}
            variant="ghost"
          >
            <PanelRightIcon className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <ApiVersionMismatchBanner />
      <SelfhostUpdateBanner />
      <header
        className={cn(
          "flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4",
          !matterColor && "bg-sidebar",
        )}
        style={
          matterColor
            ? {
                backgroundColor: `color-mix(in srgb, ${matterColor} 2%, transparent)`,
              }
            : undefined
        }
      >
        {isMobile && (
          <>
            <SidebarTrigger className="-ms-1" />
            <Separator className="me-2 h-4" orientation="vertical" />
          </>
        )}
        <AppBreadcrumbs />
        {chromeActions}
        {/* Chat routes publish their actions (move-to-side, threads, + New
            chat) here via a portal, so they land at the far end after the
            shell's own pin/matter/inspector icons without this shell importing
            any chat slice. */}
        <ChromeHeaderActionsSlot />
        <Menu
          onOpenChange={(nextOpen) => {
            setChatMenuOpen(nextOpen);
            if (!nextOpen) {
              chatMenuAnchorRef.current = null;
            }
          }}
          open={chatMenuOpen}
        >
          <MenuTrigger
            nativeButton={false}
            render={<span className="sr-only" />}
          />
          {/* eslint-disable-next-line react/react-compiler -- reads the imperatively-captured trigger anchor to position the menu; the menu-open state that gates this render is set in the same handler that captures the anchor */}
          <MenuPopup anchor={chatMenuAnchorRef.current ?? undefined}>
            <MenuItem onClick={handleOpenNewChatFromMenu}>
              <MessageSquarePlusIcon />
              {t("chat.newChat")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </header>
    </>
  );
}

type InspectorWorkspaceResolutionInput = {
  activeId: string | null;
  routeWorkspaceId: string | undefined;
  tabs: readonly InspectorTab[];
};

const resolveInspectorWorkspaceId = ({
  activeId,
  routeWorkspaceId,
  tabs,
}: InspectorWorkspaceResolutionInput): string | undefined => {
  const activeTab =
    activeId === null ? undefined : tabs.find((tab) => tab.id === activeId);
  const activeWorkspaceId = getInspectorTabWorkspaceId(activeTab);
  if (activeWorkspaceId !== undefined) {
    return activeWorkspaceId;
  }

  if (routeWorkspaceId !== undefined) {
    return routeWorkspaceId;
  }

  for (const tab of tabs) {
    const tabWorkspaceId = getInspectorTabWorkspaceId(tab);
    if (tabWorkspaceId !== undefined) {
      return tabWorkspaceId;
    }
  }

  return undefined;
};

const getInspectorTabWorkspaceId = (
  tab: InspectorTab | undefined,
): string | undefined => {
  if (tab === undefined) {
    return undefined;
  }

  switch (tab.type) {
    case "pdf":
    case "matter":
    case "task":
      return tab.workspaceId;
    case "chat":
      return tab.workspaceId ?? tab.contextMatterIds.at(0);
    case "external":
      return tab.workspaceId ?? undefined;
    case "skill-resource":
    case "view":
      return undefined;
    default: {
      tab satisfies never;
      return undefined;
    }
  }
};

/**
 * Workspace inspector pane — file viewers + chat tabs. Mounted at
 * the protected layout level (next to `TemplateAssistantSidePanel`)
 * so its mount survives matter→matter switches without the
 * resizable group it used to live inside being unmounted by the
 * `$workspaceId` route's re-render. Uses the same fixed/spacer
 * pattern as the legacy right chat so the pane spans the full
 * viewport height and the topbar doesn't need to leave room for
 * inspector chrome.
 */
function WorkspaceInspectorSidePanel() {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const projectMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const routeWorkspaceId = projectMatch?.params.workspaceId;
  const tabs = useInspectorTabsStore((s) => s.tabs);
  const activeId = useInspectorTabsStore((s) => s.activeId);
  const minimized = useInspectorTabsStore((s) => s.minimized);
  const setMinimized = useInspectorTabsStore((s) => s.setMinimized);
  // Desktop keeps a rail-mounted inspector shell; mobile uses a
  // sheet and relies on the topbar restore button after Back.
  // Pane content is shown only when a tab exists and the inspector
  // is not minimized.
  const showPaneContent = tabs.length > 0 && !minimized;
  const activeWorkspaceId = resolveInspectorWorkspaceId({
    activeId,
    routeWorkspaceId,
    tabs,
  });
  // The pane's width policy (the dragged width, its clamp against the room
  // left beside the sidebar, pointer and keyboard resizing) is the shared
  // inspector's; this panel only supplies the sidebar's inline size.
  const sidebarWidth = useSidebarInlineSize();
  const viewportWidth = useViewportWidth();
  const { resetWidth, resizeHandleProps, width } = useInspectorPaneWidth({
    sidebarWidth,
    viewportWidth,
  });
  // Re-run the offset effect once the new bundle applies: `loadedLang` (not
  // `lang`) is what flips document.documentElement.dir, so depending on it
  // reads the correct direction.
  const loadedLang = useI18nStore((s) => s.loadedLang);

  // Rail is always shown; only when there are real tabs and the
  // user hasn't minimized do we widen to the full pane width.
  const dockWidth = showPaneContent ? width : INSPECTOR_RAIL_WIDTH;
  const reservedInlineEndWidthPx = isMobile ? "0px" : `${dockWidth}px`;

  useExternalSyncEffect(() => {
    // The toast offset is consumed via a logical `end-` utility, so the same
    // value reserves the correct edge in both directions.
    document.documentElement.style.setProperty(
      TOAST_RIGHT_OFFSET_VAR,
      reservedInlineEndWidthPx,
    );
    // Folio's find/replace overlay is `justify-end`, so it packs against the
    // inline-end edge: the right in LTR, the LEFT under RTL. The inspector
    // docks to that same edge, so reserve the offset on whichever physical
    // side both occupy and clear the other. In LTR reserve the right (left
    // keeps its default); in RTL the pane docks left (end-0), so reserve the
    // left and clear the right. The overlay reads --folio-find-replace-left in
    // its width calc too, so setting it also keeps the dialog from overflowing
    // the inspector.
    const isRtl = document.documentElement.dir === "rtl";
    document.documentElement.style.setProperty(
      "--folio-find-replace-right",
      isRtl ? "0px" : reservedInlineEndWidthPx,
    );
    if (isRtl) {
      document.documentElement.style.setProperty(
        "--folio-find-replace-left",
        reservedInlineEndWidthPx,
      );
    } else {
      document.documentElement.style.removeProperty(
        "--folio-find-replace-left",
      );
    }

    return () => {
      document.documentElement.style.removeProperty(TOAST_RIGHT_OFFSET_VAR);
      document.documentElement.style.removeProperty(
        "--folio-find-replace-right",
      );
      document.documentElement.style.removeProperty(
        "--folio-find-replace-left",
      );
    };
  }, [reservedInlineEndWidthPx, loadedLang]);

  if (isMobile) {
    return (
      <Sheet
        onOpenChange={(open) => {
          setMinimized(!open);
        }}
        open={showPaneContent}
      >
        <SheetPopup
          className="h-dvh w-full max-w-none border-0 p-0 md:hidden"
          showCloseButton={false}
          side="inline-end"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("inspector.title")}</SheetTitle>
          </SheetHeader>
          <Suspense fallback={<MobileInspectorFallback />}>
            <LazyInspectorPanel workspaceId={activeWorkspaceId} />
          </Suspense>
        </SheetPopup>
      </Sheet>
    );
  }

  // The panel owns its rail (the tab strip lives inside `InspectorPanel`), so
  // the dock gets the whole panel as its content and no `rail` of its own;
  // the collapsed width is the rail's, passed in as the dock's width.
  return (
    <InspectorDock
      resizeHandleLabel={t("inspector.resizePane")}
      resizeHandleProps={resizeHandleProps}
      showPaneContent={showPaneContent}
      width={dockWidth}
      onResetWidth={resetWidth}
    >
      <Suspense fallback={<InspectorRailFallback />}>
        <LazyInspectorPanel workspaceId={activeWorkspaceId} />
      </Suspense>
    </InspectorDock>
  );
}
