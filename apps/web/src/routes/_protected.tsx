import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
  useRouterState,
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
import { cn } from "@stll/ui/lib/utils";

import { ApiVersionMismatchBanner } from "@/components/api-version-mismatch-banner";
import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { InspectorSidePanel } from "@/components/inspector-side-panel";
import {
  initializeInspectorTabBroadcast,
  useInspectorStore,
} from "@/components/inspector/inspector-store";
import "@/components/inspector/view-registry-builtins";
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
import { HOTKEYS } from "@/lib/hotkeys";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { prefetchNonCriticalQuery } from "@/lib/react-query";
import { roleOptions } from "@/routes/-queries";
import { useGlobalChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-global-chat-mention-registration";
import { CaseSearchTrigger } from "@/routes/_protected.knowledge/case/-components/case-viewer/case-search-trigger";
import { DecisionMetadataSheet } from "@/routes/_protected.knowledge/case/-components/case-viewer/decision-metadata-sheet";
import { CreateMatterDialog } from "@/routes/_protected.workspaces/-components/create-matter-dialog";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

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

    // Seed the pinned-matters store from localStorage before the
    // sidebar renders. The store's `init` is idempotent (skips when
    // the same userId is already loaded), so re-runs on navigation
    // cost nothing and a render-time effect is unnecessary.
    usePinnedStore.getState().init(context.session.userId);

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

  // Auto-close registry-backed views whose owning route the user
  // has navigated away from. Built-in workspace tabs (PDFs, chats,
  // tasks…) opt out by registering with `navigationPolicy: "persist"`,
  // so this hook only ever drops tabs from non-workspace routes
  // that explicitly opt into route-leave teardown.
  const activeRouteId = useRouterState({
    select: (state) => state.matches.at(-1)?.routeId,
  });
  const previousRouteIdRef = useRef<string | undefined>(activeRouteId);
  useEffect(() => {
    const previousRouteId = previousRouteIdRef.current;
    previousRouteIdRef.current = activeRouteId;
    if (previousRouteId !== undefined && previousRouteId !== activeRouteId) {
      useInspectorStore.getState().closeTabsForRoute(previousRouteId);
    }
  }, [activeRouteId]);

  return (
    <SidebarProvider>
      <ChatMentionProviders>
        <AIAvailabilityProvider>
          <ChatEditorProvider>
            <GlobalChatMentionRegistration />
            <AppSidebar />
            <CreateMatterDialog />
            <ProtectedContent decisionId={activeDecisionId} />
            <InspectorSidePanel />
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
