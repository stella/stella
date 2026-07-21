import { lazy, Suspense, useCallback, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import {
  MessageSquarePlusIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { Separator } from "@stll/ui/components/separator";
import {
  Sheet,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/components/sheet";
import { Skeleton } from "@stll/ui/components/skeleton";
import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { ApiVersionMismatchBanner } from "@/components/api-version-mismatch-banner";
import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { ModelSelectorDialog } from "@/components/chat/model-selector-dialog";
import {
  initializeInspectorTabBroadcast,
  useInspectorStore,
} from "@/components/inspector/inspector-store";
import type { InspectorTab } from "@/components/inspector/inspector-store";
import { MatterIcon } from "@/components/matter-icon";
import { AIAvailabilityProvider } from "@/components/require-ai-key";
import { SelfhostUpdateBanner } from "@/components/selfhost-update-banner";
import { ShortcutHintsOverlay } from "@/components/shortcut-hints-overlay";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useI18nStore } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import { ChromeHeaderActionsSlot } from "@/lib/chrome-header-actions";
import {
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";
import { detached } from "@/lib/detached";
import { HOTKEYS } from "@/lib/hotkeys";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { prefetchRouteQuery } from "@/lib/react-query";
import { loadAuthContext } from "@/routes/-auth-context";
import { roleOptions } from "@/routes/-queries";
import { useGlobalChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-global-chat-mention-registration";
import { aiAvailabilityOptions } from "@/routes/_protected.organization/-ai-config-queries";
import { CreateMatterDialog } from "@/routes/_protected.workspaces/-components/create-matter-dialog";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

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
const InspectorRailFallback = () => (
  <div className="bg-background flex h-full border-s shadow-lg">
    <div
      className={`bg-muted/50 flex shrink-0 flex-col border-e ${SIDE_RAIL_WIDTH}`}
    >
      <div
        aria-hidden="true"
        className={`text-muted-foreground flex w-full shrink-0 items-center justify-center border-b ${TOOLBAR_ROW_HEIGHT}`}
      >
        <span
          className={`flex items-center justify-center ${SIDE_RAIL_ICON_BUTTON_SIZE}`}
        >
          <PanelRightIcon className="size-4" />
        </span>
      </div>
      <div className="flex-1" />
      <div
        aria-hidden="true"
        className={`text-muted-foreground flex w-full shrink-0 items-center justify-center border-t ${TOOLBAR_ROW_HEIGHT}`}
      >
        <span
          className={`flex items-center justify-center ${SIDE_RAIL_ICON_BUTTON_SIZE}`}
        >
          <MessageSquarePlusIcon className="size-4" />
        </span>
      </div>
    </div>
  </div>
);

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
    // failure. So we AWAIT the role prefetch fully — no time-boxed race that
    // could let chrome render while the fetch is still in flight. The prefetch is
    // non-throwing, so a role-fetch failure resolves it rather than stalling or
    // taking down the shell.
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };
    detached(
      prefetchRouteQuery(
        context.queryClient,
        aiAvailabilityOptions({ organizationId: activeOrganizationId }),
        onPrefetchError,
      ),
      "beforeLoad",
    );
    await prefetchRouteQuery(context.queryClient, roleOptions, onPrefetchError);

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
          className={`flex shrink-0 items-center gap-2 ${TOOLBAR_ROW_HEIGHT}`}
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
          className={`flex shrink-0 items-center gap-3 border-b px-4 ${TOOLBAR_ROW_HEIGHT}`}
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
        className={`bg-muted/50 hidden shrink-0 flex-col border-s md:flex ${SIDE_RAIL_WIDTH}`}
      >
        <div
          className={`flex w-full shrink-0 items-center justify-center border-b ${TOOLBAR_ROW_HEIGHT}`}
        >
          <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
        </div>
        <div className="flex-1" />
        <div
          className={`flex w-full shrink-0 items-center justify-center border-t ${TOOLBAR_ROW_HEIGHT}`}
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
    const store = useInspectorStore.getState();
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
  useHotkey(HOTKEYS.TOGGLE_CHAT, handleToggleInspectorHotkey);

  return (
    <AuthenticatedUserProvider user={analyticsUser}>
      <SidebarProvider>
        <ChatMentionProviders>
          <AIAvailabilityProvider>
            <ChatEditorProvider>
              <GlobalChatMentionRegistration />
              <AppSidebar />
              <CreateMatterDialog />
              <ProtectedContent />
              <WorkspaceInspectorSidePanel />
              <ShortcutHintsOverlay />
              <ModelSelectorDialog />
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

  // Inspector toggle wiring — the right-side `PanelRightIcon`
  // button is the universal entry point for the inspector pane.
  // It's available everywhere (workspace, knowledge, dashboards),
  // not just inside a matter, so users can pop a minimised pane
  // back open from any route. Inside a workspace it doubles as
  // "create new chat" when no tabs are open yet.
  const inspectorMinimized = useInspectorStore((s) => s.minimized);
  const inspectorTabsCount = useInspectorStore((s) => s.tabs.length);
  const toggleInspector = useInspectorStore((s) => s.toggleMinimized);
  const openInspectorChat = useInspectorStore((s) => s.openChat);
  const openMatterInspector = useInspectorStore((s) => s.openMatter);
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
            <MatterIcon
              className="size-4"
              matter={{ id: workspaceId, color: workspace?.color ?? null }}
            />
          </Button>
        </>
      )}
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
    <SidebarInset className="flex flex-col">
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
      <Outlet />
    </SidebarInset>
  );
}

const INSPECTOR_PANE_DEFAULT_WIDTH = 512;
const INSPECTOR_PANE_MIN_WIDTH = 320;
const INSPECTOR_PANE_MAX_WIDTH = 800;
// Matches SIDE_RAIL_WIDTH (`w-12` = 48px) so the wrapper width
// equals the rail's actual rendered width. Earlier this was 40,
// leaving the rail 8px wider than its wrapper and pushing the
// toast / find-replace right-offset CSS vars under the visible rail.
const INSPECTOR_RAIL_WIDTH = 48;

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
      const exhaustive: never = tab;
      return exhaustive;
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
  const tabs = useInspectorStore((s) => s.tabs);
  const activeId = useInspectorStore((s) => s.activeId);
  const minimized = useInspectorStore((s) => s.minimized);
  const setMinimized = useInspectorStore((s) => s.setMinimized);
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
  const [width, setWidth] = useState(INSPECTOR_PANE_DEFAULT_WIDTH);
  const isDragging = useRef(false);
  // Re-run the offset effect once the new bundle applies: `loadedLang` (not
  // `lang`) is what flips document.documentElement.dir, so depending on it
  // reads the correct direction.
  const loadedLang = useI18nStore((s) => s.loadedLang);

  const handlePointerDown = (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    isDragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!isDragging.current) {
      return;
    }
    // The pane docks to the inline-end edge: that's the right in LTR
    // (width = distance from the right) and the left in RTL (width =
    // distance from the left). Without the RTL branch the delta is
    // inverted and the drag oscillates.
    const isRtl = document.documentElement.dir === "rtl";
    const newWidth = isRtl ? e.clientX : window.innerWidth - e.clientX;
    setWidth(
      Math.min(
        INSPECTOR_PANE_MAX_WIDTH,
        Math.max(INSPECTOR_PANE_MIN_WIDTH, newWidth),
      ),
    );
  };

  const handlePointerUp = () => {
    isDragging.current = false;
  };

  // Rail is always shown; only when there are real tabs and the
  // user hasn't minimized do we widen to the full pane width.
  const widthPx = `${showPaneContent ? width : INSPECTOR_RAIL_WIDTH}px`;
  const reservedInlineEndWidthPx = isMobile ? "0px" : widthPx;

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

  return (
    <div
      className="text-sidebar-foreground hidden md:block"
      data-side="right"
      data-state={showPaneContent ? "expanded" : "collapsed"}
    >
      <div className="bg-sidebar relative" style={{ width: widthPx }} />
      <div
        className="fixed inset-y-0 end-0 z-10 hidden h-svh md:flex"
        style={{ width: widthPx }}
      >
        {showPaneContent && (
          <div
            className="hover:bg-border active:bg-border absolute inset-y-0 -start-px z-20 flex w-1 cursor-col-resize items-center justify-center border-s"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        )}
        <div className="bg-sidebar flex h-full w-full flex-col">
          <Suspense fallback={<InspectorRailFallback />}>
            <LazyInspectorPanel workspaceId={activeWorkspaceId} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
