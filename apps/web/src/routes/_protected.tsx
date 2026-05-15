import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { MouseEvent } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import {
  LayersIcon,
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
import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { ApiVersionMismatchBanner } from "@/components/api-version-mismatch-banner";
import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { AIAvailabilityProvider } from "@/components/require-ai-key";
import { DefaultPendingComponent } from "@/components/route-components";
import { SelfhostUpdateBanner } from "@/components/selfhost-update-banner";
import { ShortcutHintsOverlay } from "@/components/shortcut-hints-overlay";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar";
import { getAnalytics } from "@/lib/analytics/provider";
import {
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";
import { HOTKEYS } from "@/lib/hotkeys";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { prefetchNonCriticalQuery } from "@/lib/react-query";
import { roleOptions } from "@/routes/-queries";
import { useGlobalChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-global-chat-mention-registration";
import { CaseSearchTrigger } from "@/routes/_protected.knowledge/case/-components/case-viewer/case-search-trigger";
import { DecisionMetadataSheet } from "@/routes/_protected.knowledge/case/-components/case-viewer/decision-metadata-sheet";
import {
  initializeInspectorTabBroadcast,
  useInspectorStore,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type { InspectorTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { CreateMatterDialog } from "@/routes/_protected.workspaces/-components/create-matter-dialog";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

const LazyInspectorPanel = lazy(
  async () =>
    await import("@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-panel").then(
      (m) => ({ default: m.InspectorPanel }),
    ),
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

export const Route = createFileRoute("/_protected")({
  beforeLoad: ({ context, location }) => {
    if (!context.session || !context.user) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
      });
    }

    if (!context.session.activeOrganizationId) {
      throw redirect({ to: "/auth/organization", replace: true });
    }

    // Prefetch role so useSuspenseQuery in the component is a
    // cache hit instead of a serial round-trip after child loaders.
    // staleTime: Infinity → only fetch on cold cache, not every
    // navigation. Errors surface to the user via useSuspenseQuery.
    void prefetchNonCriticalQuery(
      context.queryClient,
      { ...roleOptions, staleTime: Infinity },
      (error: unknown) => {
        getAnalytics().captureError(error);
      },
    );

    return {
      user: {
        id: context.session.userId,
        activeOrganizationId: context.session.activeOrganizationId,
        name: context.user.name || undefined,
        email: context.user.email,
        image: context.user.image,
        preferredName: context.user.preferredName,
        timezoneId: context.user.timezoneId,
        wordEditShortcut: context.user.wordEditShortcut,
      },
    };
  },
  component: ProtectedComponent,
  pendingComponent: () => <DefaultPendingComponent className="h-dvh" />,
});

function ProtectedComponent() {
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

  const decisionMatch = useMatch({
    from: "/_protected/knowledge/case/$decisionId",
    shouldThrow: false,
  });
  const activeDecisionId = decisionMatch?.params.decisionId;

  useEffect(
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

  // Auto-open a chat tab grounded in the active case-law decision —
  // mirrors the legacy right-panel-chat behaviour where landing on a
  // decision page opened a chat about it. Fires once per decision so
  // re-renders don't reopen a tab the user just closed; resets when
  // the user navigates to a different decision or away from the
  // case-law route. Inside a matter the chat is workspace-scoped and
  // seeded with that matter's contextMatterIds; outside a matter the
  // tab is global and only carries the decision context.
  const lastAutoOpenedDecisionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeDecisionId) {
      lastAutoOpenedDecisionRef.current = null;
      return;
    }
    if (lastAutoOpenedDecisionRef.current === activeDecisionId) {
      return;
    }
    lastAutoOpenedDecisionRef.current = activeDecisionId;
    useInspectorStore.getState().openChat(
      activeWorkspaceId === undefined
        ? { activeDecisionId }
        : {
            workspaceId: activeWorkspaceId,
            contextMatterIds: [activeWorkspaceId],
            activeDecisionId,
          },
    );
  }, [activeDecisionId, activeWorkspaceId]);

  return (
    <SidebarProvider>
      <ChatMentionProviders>
        <AIAvailabilityProvider>
          <ChatEditorProvider>
            <GlobalChatMentionRegistration />
            <AppSidebar />
            <CreateMatterDialog />
            <ProtectedContent decisionId={activeDecisionId} />
            <WorkspaceInspectorSidePanel />
            <ShortcutHintsOverlay />
          </ChatEditorProvider>
        </AIAvailabilityProvider>
      </ChatMentionProviders>
    </SidebarProvider>
  );
}

function GlobalChatMentionRegistration() {
  useGlobalChatMentionRegistration();

  return null;
}

type ProtectedContentProps = {
  decisionId: string | undefined;
};

function ProtectedContent({
  decisionId: activeDecisionId,
}: ProtectedContentProps) {
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
  // Show the chrome inspector button only before the rail exists.
  // Once tabs exist, the rail remains visible even when the pane
  // content is minimized, and its top button is the restore/hide
  // affordance.
  const canShowInspectorButton = inspectorTabsCount === 0;
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

  const { data: workspace } = useQuery({
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
            <LayersIcon
              className="size-4"
              style={matterColor ? { color: matterColor } : undefined}
            />
          </Button>
        </>
      )}
      {activeDecisionId && (
        <>
          <CaseSearchTrigger />
          <DecisionMetadataSheet decisionId={activeDecisionId} />
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
  const projectMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const routeWorkspaceId = projectMatch?.params.workspaceId;
  const tabs = useInspectorStore((s) => s.tabs);
  const activeId = useInspectorStore((s) => s.activeId);
  const minimized = useInspectorStore((s) => s.minimized);
  // The inspector rail is always mounted — even with zero tabs it
  // shows the toggle + new-chat affordances so the user has a
  // consistent right-side anchor point. The pane *content* area is
  // hidden when there are no tabs or when the user has minimized.
  const showPaneContent = tabs.length > 0 && !minimized;

  // Pin the inspector's "current matter" to the ACTIVE TAB's
  // origin so documents and started chats keep showing the
  // matter they came from, even after the user navigates away
  // to another matter (or to a non-workspace route like the
  // knowledge / case-law viewer). Resolution order:
  //   1. Active tab's origin (PDF.workspaceId, Matter.workspaceId,
  //      or started-chat contextMatterIds[0])
  //   2. The current route's matter (for blank chats or task
  //      tabs while inside a workspace)
  //   3. Any other tab's stored workspaceId — keeps the pane
  //      mounted when the user navigates away from a workspace
  //      with only blank chats active but PDFs from earlier
  //      matters still open in the rail.
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const tabOriginWorkspaceId = (() => {
    if (activeTab?.type === "pdf") {
      return activeTab.workspaceId;
    }
    if (activeTab?.type === "matter") {
      return activeTab.workspaceId;
    }
    if (activeTab?.type === "chat") {
      return activeTab.contextMatterIds.at(0) ?? null;
    }
    return null;
  })();
  // Last-resort: pick *any* tab's stored workspace so the inspector
  // mounts even when the active tab can't dictate one (a task tab,
  // or a chat that hasn't been pinned to a matter yet) and the
  // route is also non-workspace. PDF tabs carry workspaceId
  // directly; matter tabs carry workspaceId directly; chat tabs
  // surface theirs via contextMatterIds[0].
  const fallbackPdfTab = tabs.find(
    (tab): tab is Extract<InspectorTab, { type: "pdf" }> => tab.type === "pdf",
  );
  const fallbackMatterTab = tabs.find(
    (tab): tab is Extract<InspectorTab, { type: "matter" }> =>
      tab.type === "matter",
  );
  const fallbackChatTab = tabs.find(
    (tab): tab is Extract<InspectorTab, { type: "chat" }> =>
      tab.type === "chat" && tab.contextMatterIds.length > 0,
  );
  const fallbackTabWorkspaceId =
    fallbackPdfTab?.workspaceId ??
    fallbackMatterTab?.workspaceId ??
    fallbackChatTab?.contextMatterIds.at(0) ??
    null;
  const activeWorkspaceId =
    tabOriginWorkspaceId ?? routeWorkspaceId ?? fallbackTabWorkspaceId;
  const [width, setWidth] = useState(INSPECTOR_PANE_DEFAULT_WIDTH);
  const isDragging = useRef(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    isDragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) {
      return;
    }
    const newWidth = window.innerWidth - e.clientX;
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

  useEffect(() => {
    document.documentElement.style.setProperty(TOAST_RIGHT_OFFSET_VAR, widthPx);
    // Keep Folio's find/replace dialog out from under the right inspector
    // pane. Folio reads --folio-find-replace-right on the overlay so the
    // dialog lands over the document, not behind the sidebar.
    document.documentElement.style.setProperty(
      "--folio-find-replace-right",
      widthPx,
    );

    return () => {
      document.documentElement.style.removeProperty(TOAST_RIGHT_OFFSET_VAR);
      document.documentElement.style.removeProperty(
        "--folio-find-replace-right",
      );
    };
  }, [widthPx]);

  return (
    <div
      className="text-sidebar-foreground hidden md:block"
      data-side="right"
      data-state={showPaneContent ? "expanded" : "collapsed"}
    >
      <div className="bg-sidebar relative" style={{ width: widthPx }} />
      <div
        className="fixed inset-y-0 right-0 z-10 hidden h-svh md:flex"
        style={{ width: widthPx }}
      >
        {showPaneContent && (
          <div
            className="hover:bg-border active:bg-border absolute inset-y-0 -left-px z-20 flex w-1 cursor-col-resize items-center justify-center border-l"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        )}
        <div className="bg-sidebar flex h-full w-full flex-col">
          <Suspense fallback={<InspectorRailFallback />}>
            <LazyInspectorPanel workspaceId={activeWorkspaceId ?? undefined} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
