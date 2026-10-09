import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { MouseEvent, ReactNode } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { useMatch } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  CogIcon,
  NewChatIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
} from "@stll/ui/icons";
import {
  InspectorDock,
  resolveInspectorDockWidth,
  SIDE_RAIL_ICON_BUTTON_SIZE,
} from "@stll/ui/inspector";
import { matterChromeStyle, resolveMatterColor } from "@stll/ui/matter-colors";
import type { MatterChromeStyle } from "@stll/ui/matter-colors";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Separator } from "@stll/ui/separator";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";
import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/toast";
import { useViewportWidth } from "@stll/ui/use-viewport-width";
import { cn } from "@stll/ui/utils";
import { WorkspaceEndRail } from "@stll/ui/workspace-shell";

import "@/features/case-law/case-decision-details-inspector-registration";
import "@/features/case-law/case-decision-inspector-registration";
import "@/features/inbox/signal-inspector-registration";
import "@/features/knowledge/playbook-editor/playbook-draft-view-registration";
import { WorkspaceFrame } from "@stll/workspace-ui/workspace-frame";

import "@/features/statutes/provision-inspector-registration";
import "@/features/statutes/statute-inspector-registration";
import { ApiVersionMismatchReporter } from "@/components/api-version-mismatch-refresh";
import { AppSidebar } from "@/components/app-sidebar";
import { resolveSidebarWorkspaceId } from "@/components/app-sidebar.logic";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { DocxEditorHost } from "@/components/docx/docx-editor-host";
import { DragAndDropLiveRegion } from "@/components/drag-and-drop-live-region";
import {
  initializeInspectorTabBroadcast,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import { useSharedInspectorPaneWidth } from "@/components/inspector/pane-width-storage";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { NotificationBell } from "@/components/notification-bell";
import { QuickEntry } from "@/components/quick-entry";
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
import { AttachedTemplateUploadDialog } from "@/components/workspaces/attached-template-upload-dialog";
import { CreateMatterDialog } from "@/components/workspaces/create-matter-dialog";
import { DocumentReferenceUploadDialog } from "@/components/workspaces/document-reference-upload-dialog";
import { useGlobalChatMentionRegistration } from "@/features/chat/hooks/use-global-chat-mention-registration";
import { PlaybookPaneLeaveConfirmation } from "@/features/knowledge/playbook-editor/playbook-pane-leave-confirmation";
import { GlobalTimer } from "@/features/time-timers/global-timer";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { useI18nStore } from "@/i18n/i18n-store";
import { useStorageOwner } from "@/lib/account/use-owner-scoped-state";
import { AuthenticatedUserProvider } from "@/lib/authenticated-user-context";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { ChromeHeaderActionsSlot } from "@/lib/chrome-header-actions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { usePinnedStore } from "@/lib/pinned-store";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import {
  workspaceOptions,
  workspacesNavigationOptions,
} from "@/lib/workspaces/queries";
import { shouldForceSidebarCollapsed } from "@/routes/-inspector-pane-width";
import { PaymentRetryBanner } from "@/routes/-protected-app/-components/payment-retry-banner";
import {
  createSessionActivity,
  isSessionActivityCancelled,
  SESSION_ACTIVITY_INTERVAL_MS,
} from "@/routes/-session-activity";

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
    <div className="flex h-full border-s bg-(--matter-background-tint) shadow-lg">
      <WorkspaceEndRail
        chatAction={{
          label: t("chat.newChat"),
          reason: t("common.loading"),
          status: "unavailable",
        }}
        className="h-full bg-(--matter-sidebar-tint)"
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

/**
 * The signed-in app chrome: sidebar, inspector dock, chat providers and the
 * header. `_protected` renders it around its routes; any other route tree
 * that shows member pages renders it the same way for a signed-in user.
 */
export const ProtectedAppFrame = ({
  user,
  children,
}: {
  user: AuthenticatedUser;
  children: ReactNode;
}) => {
  useMountEffect(() => {
    const activity = createSessionActivity({
      page: document,
      observe: async (signal) => {
        const { authClient } = await import("@/lib/auth-client");
        const result = await authClient.getSession({
          query: { disableCookieCache: true },
          fetchOptions: { signal },
        });
        if (result.error && !isSessionActivityCancelled(result.error, signal)) {
          await Promise.reject(toAuthClientError(result.error));
        }
      },
    });
    const tick = () => detached(activity.tick(), "session.activity");
    const interval = window.setInterval(tick, SESSION_ACTIVITY_INTERVAL_MS);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      activity.dispose();
      window.clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  });
  const analyticsUser = user;
  const inspectorOwner = useStorageOwner();
  const inspectorBroadcastUserId = user.id;
  const inspectorBroadcastOrganizationId = user.activeOrganizationId;
  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const workspaceChatMatch = useMatch({
    from: "/_protected/chat/workspaces/$workspaceId/$threadId",
    shouldThrow: false,
  });
  const activeWorkspaceId = resolveSidebarWorkspaceId({
    chatWorkspaceId: workspaceChatMatch?.params.workspaceId,
    workspaceId: workspaceMatch?.params.workspaceId,
  });
  const workspaceNavigationView = useQueryView(
    useChromeQuery(
      workspacesNavigationOptions({
        organizationId: inspectorBroadcastOrganizationId,
        userId: inspectorBroadcastUserId,
      }),
    ),
  );
  useQueryViewError(workspaceNavigationView);
  const workspaceNavigation =
    workspaceNavigationView.type === "items"
      ? workspaceNavigationView.items
      : undefined;
  const activeWorkspace = workspaceNavigation?.workspaces.find(
    ({ id }) => id === activeWorkspaceId,
  );
  const activeMatterColor = activeWorkspaceId
    ? resolveMatterColor(activeWorkspaceId, activeWorkspace?.color ?? null)
    : null;
  const routeMatterChromeStyle = matterChromeStyle(activeMatterColor);
  const inspectorPaneOpen = useInspectorTabsStore(
    (state) => state.tabs.length > 0 && !state.minimized,
  );
  const viewportWidth = useViewportWidth();
  const forceSidebarCollapsed = shouldForceSidebarCollapsed({
    inspectorPaneOpen,
    viewportWidth,
  });

  // Restore the authenticated tab scope before any previous scope can paint.
  useLayoutEffect(() => {
    if (
      inspectorOwner.kind !== "user" ||
      inspectorOwner.userId !== inspectorBroadcastUserId
    ) {
      return undefined;
    }
    return initializeInspectorTabBroadcast({
      organizationId: inspectorBroadcastOrganizationId,
      userId: inspectorBroadcastUserId,
    });
  }, [
    inspectorBroadcastOrganizationId,
    inspectorBroadcastUserId,
    inspectorOwner,
  ]);

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
  useHotkey(useEffectiveHotkey("newChat"), () => {
    useInspectorTabsStore.getState().openChat(
      activeWorkspaceId === undefined
        ? {}
        : {
            workspaceId: activeWorkspaceId,
            contextMatterIds: [activeWorkspaceId],
          },
    );
  });

  return (
    <AuthenticatedUserProvider
      key={`${inspectorBroadcastOrganizationId}:${inspectorBroadcastUserId}`}
      user={analyticsUser}
    >
      <div className="contents" style={routeMatterChromeStyle}>
        <SidebarProvider forceCollapsed={forceSidebarCollapsed}>
          <SidebarToggleHotkey />
          <ChatMentionProviders>
            <AIAvailabilityProvider>
              <ChatEditorProvider>
                <GlobalChatMentionRegistration />
                <PlaybookPaneLeaveConfirmation />
                <DragAndDropLiveRegion />
                <WorkspaceFrame
                  composition="host-responsive"
                  endDock={
                    <WorkspaceInspectorSidePanel
                      routeMatterChromeStyle={routeMatterChromeStyle}
                    />
                  }
                  navigation={{ content: <AppSidebar />, mode: "responsive" }}
                  topBar={() => <ProtectedContent />}
                >
                  {children}
                </WorkspaceFrame>
                {/* Above both the outlet and the inspector: the DOCX editor
                    moves between their two slots instead of being rebuilt
                    when the document and the review trade panes. */}
                <DocxEditorHost />
                <QuickEntry />
                <CreateMatterDialog />
                <AttachedTemplateUploadDialog />
                <DocumentReferenceUploadDialog />
                <ShortcutEchoHud />
                <KeyboardShortcutsDialog />
              </ChatEditorProvider>
            </AIAvailabilityProvider>
          </ChatMentionProviders>
        </SidebarProvider>
      </div>
    </AuthenticatedUserProvider>
  );
};

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

  const workspaceView = useQueryView(
    useChromeQuery({
      ...workspaceOptions(workspaceId ?? ""),
      enabled: !!workspaceId,
    }),
  );
  useQueryViewError(workspaceView);
  const workspace =
    workspaceView.type === "items" ? workspaceView.items : undefined;
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
      <GlobalTimer />
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
      <ApiVersionMismatchReporter />
      <SelfhostUpdateBanner />
      <PaymentRetryBanner />
      <header className="border-sidebar-border flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b bg-(--matter-sidebar-tint) px-4">
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
          {/* oxlint-disable-next-line react/refs -- reads the imperatively-captured trigger anchor to position the menu; the menu-open state that gates this render is set in the same handler that captures the anchor */}
          <MenuPopup anchor={chatMenuAnchorRef.current ?? undefined}>
            <MenuItem onClick={handleOpenNewChatFromMenu}>
              <NewChatIcon />
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
      return panic(`Unhandled tab: ${String(tab)}`);
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
function WorkspaceInspectorSidePanel({
  routeMatterChromeStyle,
}: {
  routeMatterChromeStyle: MatterChromeStyle;
}) {
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
  const { resetWidth, resizeHandleProps, width } = useSharedInspectorPaneWidth({
    openedFrom: "matter",
    sidebarWidth,
    viewportWidth,
  });
  // Re-run the offset effect once the new bundle applies: `loadedLang` (not
  // `lang`) is what flips document.documentElement.dir, so depending on it
  // reads the correct direction.
  const loadedLang = useI18nStore((s) => s.loadedLang);

  // Rail is always shown; only when there are real tabs and the
  // user hasn't minimized do we widen to the full pane width.
  const dockWidth = resolveInspectorDockWidth({
    paneWidth: width,
    showPaneContent,
  });
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
          style={routeMatterChromeStyle}
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
