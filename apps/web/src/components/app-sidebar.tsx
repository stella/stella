import type * as React from "react";
import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  hashKey,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  useMatch,
  useRouterState,
} from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleHelpIcon,
  EllipsisVerticalIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import { SIDE_RAIL_ICON_BUTTON_SIZE } from "@stll/ui/inspector";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";
import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import {
  matterActivityIsKnownEmpty,
  resolveEntityActivityDestination,
  resolveAutomaticExpandedMatterId,
  resolveMatterNavigationTarget,
  resolveSidebarWorkspaceId,
  selectRecentWorkspaces,
} from "@/components/app-sidebar.logic";
import { openEntityInInspector } from "@/components/chat/entity-open";
import { navigateToWorkspaceFolder } from "@/components/chat/folder-navigation";
import {
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "@/components/drag-and-drop-live-region.logic";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterActivityRow } from "@/components/matter-activity-row";
import { MatterIcon } from "@/components/matter-icon";
import { SearchDialog } from "@/components/search-dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/sidebar";
import { SidebarUserMenu } from "@/components/sidebar-user-menu";
import { StellaWordmark } from "@/components/stella-wordmark";
import Tooltip from "@/components/tooltip";
import {
  getWorkspacePrimaryNavItems,
  type WorkspacePrimaryNavId,
} from "@/components/workspace-primary-nav";
import { CopyToMatterDialog } from "@/components/workspaces/copy-to-matter-dialog";
import type { CopyToMatterEntity } from "@/components/workspaces/copy-to-matter-dialog.logic";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { MatterColorContextPicker } from "@/components/workspaces/matter-color-picker";
import {
  MatterMenuHeader,
  MatterMenuItems,
  useMatterActions,
} from "@/components/workspaces/matter-context-menu";
import {
  groupedChatThreadsOptions,
  mergeGroupedChatThreadPages,
} from "@/features/chat/queries";
import { useChromeQuery, useHasMounted } from "@/hooks/use-chrome-query";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { useInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { usePublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { detached } from "@/lib/detached";
import { formatHotkeyForPlatform, NAV_KEY } from "@/lib/hotkeys";
import { inboxCountOptions } from "@/lib/inbox/queries";
import { knowledgeSections } from "@/lib/knowledge/navigation";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import type { EntityKind } from "@/lib/types";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { ENTITY_DRAG_TYPE } from "@/lib/workspaces/drag-constants";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";
import {
  workspaceActivityOptions,
  workspacesKeys,
  workspacesNavigationOptions,
} from "@/lib/workspaces/queries";

// Scrollable group body. Hide the scrollbar in the collapsed icon rail (matches
// SidebarContent); a thin track over the narrow icon strip reads as a bright
// artifact rather than chrome.
const SCROLLABLE_GROUP_CONTENT =
  "overflow-x-hidden overflow-y-auto group-data-[collapsible=icon]:[scrollbar-width:none] group-data-[collapsible=icon]:[&::-webkit-scrollbar]:hidden";

// Lazy so the guides feature stays out of the shell bundle until the user
// opens Help. The spotlight engine remains a second, runner-owned lazy chunk.
const GuideHelpDrawer = lazy(async () => {
  const module = await import("@/features/guides/guide-help-drawer");
  return { default: module.GuideHelpDrawer };
});

const GUIDE_DRAWER_STATES = {
  closed: "closed",
  idle: "idle",
  open: "open",
} as const;

type GuideDrawerState =
  (typeof GUIDE_DRAWER_STATES)[keyof typeof GUIDE_DRAWER_STATES];

export const AppSidebar = (props: AppSidebarProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  const navigate = routeApi.useNavigate();
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const canUseStyleSets = usePermissions({ styleSet: ["use"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
  const { state, toggleSidebar, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;
  const publicLawPreviewEnabled = usePublicLawPreviewEnabled();
  const workflowsPreviewEnabled = useWorkflowsPreviewEnabled();
  const inboxPreviewEnabled = useInboxPreviewEnabled();
  const primaryNavItems = getWorkspacePrimaryNavItems({
    includeInbox: inboxPreviewEnabled,
    includePublicLaw: publicLawPreviewEnabled,
    // The public /tools catalogue stays out of the authenticated app
    // nav; signed-in users manage tools via /knowledge/tools instead.
    includePublicTools: false,
  });
  const user = useAuthenticatedUser();

  const [searchOpen, setSearchOpen] = useState(false);
  const [guideDrawerState, setGuideDrawerState] = useState<GuideDrawerState>(
    GUIDE_DRAWER_STATES.idle,
  );
  const [pendingEntityDrop, setPendingEntityDrop] =
    useState<PendingEntityDrop | null>(null);
  const { pinnedOrder, pinnedIds, togglePin, reorderPinned } = usePinnedStore(
    useShallow((s) => ({
      pinnedOrder: s.pinnedOrder,
      pinnedIds: s.pinnedIds,
      togglePin: s.togglePin,
      reorderPinned: s.reorder,
    })),
  );
  const { data: workspacesData, isPending: workspacesPending } = useChromeQuery(
    workspacesNavigationOptions(user.activeOrganizationId),
  );
  const { data: inboxCount } = useChromeQuery({
    ...inboxCountOptions(user.activeOrganizationId),
    enabled: inboxPreviewEnabled,
  });
  const openInboxCount = inboxCount?.count ?? 0;
  const mounted = useHasMounted();
  const { data: groupedChatThreadPages } = useInfiniteQuery({
    ...groupedChatThreadsOptions({
      activeOrganizationId: user.activeOrganizationId,
    }),
    enabled: mounted,
  });
  const groupedChatThreads = mergeGroupedChatThreadPages(
    groupedChatThreadPages?.pages,
  );
  const chatActivityByWorkspaceId = new Map(
    groupedChatThreads.workspaces.flatMap((workspace) => {
      const updatedAt = workspace.threads.at(0)?.updatedAt;
      return updatedAt ? [[workspace.workspaceId, updatedAt] as const] : [];
    }),
  );
  const workspaces = workspacesData?.workspaces;

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
  const activeWorkspace = workspaces?.find((ws) => ws.id === activeWorkspaceId);
  const activeMatterColor =
    activeWorkspaceId && activeWorkspace
      ? resolveMatterColor(activeWorkspaceId, activeWorkspace.color)
      : null;
  const sidebarStyle: AppSidebarStyle | undefined = activeMatterColor
    ? {
        "--matter-sidebar-tint": `color-mix(in srgb, ${activeMatterColor} 2%, var(--sidebar))`,
      }
    : undefined;

  const handleCreateWorkspace = () => {
    if (!canCreateMatter) {
      return;
    }
    openCreateMatter();
  };

  // The delete + toast + cache invalidation are owned by the shared
  // matter menu (useMatterActions). The sidebar only needs to leave the
  // matter route when the matter the user is viewing is the one deleted.
  const handleMatterDeleted = (workspaceId: string) => {
    if (workspaceMatch?.params.workspaceId === workspaceId) {
      detached(navigate({ to: "/workspaces" }), "app-sidebar.navigate");
    }
  };

  // Opens the copy/move dialog pre-targeted to the matter an entity was
  // dropped onto. The source workspace is the matter currently open (entities
  // can only be dragged from the open matter's table). Skips no-op drops onto
  // the same matter the entity already lives in.
  const handleEntityDropOnMatter = (
    targetWorkspaceId: string,
    entities: CopyToMatterEntity[],
  ) => {
    if (!activeWorkspaceId || targetWorkspaceId === activeWorkspaceId) {
      return;
    }
    if (entities.length === 0) {
      return;
    }
    setPendingEntityDrop({
      sourceWorkspaceId: activeWorkspaceId,
      targetWorkspaceId,
      entities,
    });
  };

  const searchHotkey = useEffectiveHotkey("search");
  useHotkey(searchHotkey, () => {
    setSearchOpen((prev) => !prev);
  });

  useHotkey(useEffectiveHotkey("newMatter"), () => {
    handleCreateWorkspace();
  });

  const pinned = useMemo(() => {
    if (!workspaces) {
      return [];
    }
    const wsMap = new Map<string, (typeof workspaces)[number]>(
      workspaces.map((ws) => [ws.id, ws]),
    );
    return pinnedOrder
      .map((id) => wsMap.get(id))
      .filter((ws) => ws !== undefined);
  }, [workspaces, pinnedOrder]);

  const recents = workspaces
    ? selectRecentWorkspaces({
        activeWorkspaceId,
        chatActivityByWorkspaceId,
        limit: RECENTS_LIMIT,
        pinnedIds,
        workspaces,
      })
    : [];

  const [matterExpansion, setMatterExpansion] = useState<MatterExpansion>({
    type: "automatic",
  });
  const activeMatterIsVisible = [...pinned, ...recents].some(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  const automaticExpandedMatterId = resolveAutomaticExpandedMatterId({
    activeMatterIsVisible,
    activeWorkspaceId,
  });
  const expandedMatterId =
    matterExpansion.type === "automatic"
      ? automaticExpandedMatterId
      : matterExpansion.workspaceId;

  const toggleMatterExpansion = (workspaceId: string) => {
    setMatterExpansion({
      type: "selected",
      workspaceId: expandedMatterId === workspaceId ? null : workspaceId,
    });
  };

  // Hold-to-reveal nav badges (Control on Mac, Alt on Win/Linux)
  const [showNavBadges, setShowNavBadges] = useState(false);

  const showBadges = useDebouncedCallback(
    () => setShowNavBadges(true),
    HOLD_DELAY_MS,
  );

  useExternalSyncEffect(() => {
    const hideBadges = () => {
      showBadges.cancel();
      setShowNavBadges(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === NAV_KEY && !event.repeat) {
        showBadges();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === NAV_KEY) {
        hideBadges();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hideBadges();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", hideBadges);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", hideBadges);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      showBadges.cancel();
    };
  }, [showBadges]);

  type NavTarget = {
    action: () => void;
  };

  type FixedNavTarget = NavTarget & {
    contextMenu: NavContextMenuConfig;
  };

  const recentMatterAction = (ws: MatterIdentity): ContextAction => ({
    id: ws.id,
    label: ws.name,
    icon: (
      <MatterIcon
        className="size-4 shrink-0"
        matter={{ id: ws.id, color: ws.color }}
      />
    ),
    onClick: () => {
      detached(
        navigate(resolveMatterNavigationTarget(ws)),
        "app-sidebar.navigate",
      );
    },
  });

  const openChat = () => {
    detached(navigate({ to: "/chat" }), "app-sidebar.navigate");
  };

  const knowledgeRecents: ContextAction[] = [];
  for (const s of knowledgeSections) {
    if (s.key === "styles" && !canUseStyleSets) {
      continue;
    }
    if (s.key === "workflows" && !workflowsPreviewEnabled) {
      continue;
    }
    const Icon = s.icon;
    knowledgeRecents.push({
      id: s.key,
      label: t(s.titleKey),
      icon: <Icon />,
      onClick: () => {
        detached(navigate({ to: s.to }), "app-sidebar.navigate");
      },
    });
  }

  const fixedNavTargetsById = {
    search: {
      action: () => setSearchOpen(true),
      contextMenu: {
        primaryAction: {
          id: "search-primary",
          label: t("navigation.search"),
          icon: <SearchIcon />,
          onClick: () => setSearchOpen(true),
        },
      },
    },
    chat: {
      action: openChat,
      contextMenu: {
        primaryAction: {
          id: "chat-primary",
          label: t("chat.newChat"),
          icon: <PlusIcon />,
          onClick: openChat,
        },
      },
    },
    inbox: {
      action: () => {
        detached(navigate({ to: "/inbox" }), "app-sidebar.navigate");
      },
      contextMenu: {},
    },
    matters: {
      action: () => {
        detached(navigate({ to: "/workspaces" }), "app-sidebar.navigate");
      },
      contextMenu: {
        primaryAction: {
          id: "matters-primary",
          label: t("common.newMatter"),
          icon: <PlusIcon />,
          onClick: handleCreateWorkspace,
        },
        recents: recents.slice(0, 3).map(recentMatterAction),
      },
    },
    caseLaw: {
      action: () => {
        detached(navigate({ to: "/law/cases" }), "app-sidebar.navigate");
      },
      contextMenu: {},
    },
    tools: {
      action: () => {
        detached(navigate({ to: "/tools" }), "app-sidebar.navigate");
      },
      contextMenu: {},
    },
    knowledge: {
      action: () => {
        detached(navigate({ to: "/knowledge" }), "app-sidebar.navigate");
      },
      contextMenu: {
        recents: knowledgeRecents,
      },
    },
    contacts: {
      action: () => {
        detached(navigate({ to: "/contacts" }), "app-sidebar.navigate");
      },
      contextMenu: {
        primaryAction: {
          id: "contacts-primary",
          label: t("navigation.contacts"),
          icon: <UsersIcon />,
          onClick: () => {
            detached(navigate({ to: "/contacts" }), "app-sidebar.navigate");
          },
        },
      },
    },
  } satisfies Record<WorkspacePrimaryNavId, FixedNavTarget>;

  const fixedNavTargets = primaryNavItems.map(
    (item) => fixedNavTargetsById[item.id],
  );

  const navTargets: NavTarget[] = [
    ...fixedNavTargets,
    ...pinned.slice(0, 3).map((ws): NavTarget => ({
      action: () => {
        detached(
          navigate(resolveMatterNavigationTarget(ws)),
          "app-sidebar.navigate",
        );
      },
    })),
  ];

  const runNavTarget = useLatestCallback((index: number): boolean => {
    const navTarget = navTargets.at(index);
    if (!navTarget) {
      return false;
    }
    navTarget.action();
    return true;
  });

  useExternalSyncEffect(() => {
    if (!showNavBadges) {
      return undefined;
    }

    const handler = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const digit = Number.parseInt(e.key, 10);
      if (Number.isNaN(digit)) {
        return;
      }
      if (digit >= 1 && runNavTarget(digit - 1)) {
        e.preventDefault();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showNavBadges, runNavTarget]);

  return (
    <Sidebar
      {...props}
      className={cn(
        // Unified glass language with the chat composer tray: the same
        // translucent veil + backdrop-blur-md instead of the solid
        // sidebar fill so the app chrome reads as one system. The
        // opaque-leaning fallback keeps contrast where backdrop-filter
        // is unsupported. The matter tint keeps the identical alpha so
        // accent-tinted sidebars stay in the same language.
        "[&_[data-slot=sidebar-inner]]:bg-sidebar/80 supports-[backdrop-filter]:[&_[data-slot=sidebar-inner]]:bg-sidebar/60 [&_[data-slot=sidebar-inner]]:backdrop-blur-md",
        activeMatterColor &&
          "[&_[data-slot=sidebar-inner]]:bg-(--matter-sidebar-tint)/80 supports-[backdrop-filter]:[&_[data-slot=sidebar-inner]]:bg-(--matter-sidebar-tint)/60",
        props.className,
      )}
      collapsible="icon"
      style={{ ...sidebarStyle, ...props.style }}
    >
      {/* Stella logo header */}
      <SidebarHeader className="h-12 border-b p-0">
        <div
          className={cn(
            isCollapsed
              ? "flex h-full items-center justify-center"
              : "flex h-full items-center justify-between ps-3 pe-2",
          )}
        >
          {!isCollapsed && <StellaWordmark className="h-5 w-auto" />}
          <Tooltip
            content={
              isCollapsed ? t("inspector.showPane") : t("inspector.hidePane")
            }
            render={
              <Button
                className={cn(
                  "text-muted-foreground",
                  SIDE_RAIL_ICON_BUTTON_SIZE,
                )}
                onClick={toggleSidebar}
                size="icon"
                variant="ghost"
              />
            }
            side="right"
          >
            <PanelLeftIcon className="size-4" />
            <span className="sr-only">
              {isCollapsed ? t("inspector.showPane") : t("inspector.hidePane")}
            </span>
          </Tooltip>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Top navigation */}
        <SidebarGroup>
          <SidebarMenu>
            {primaryNavItems.map((item, index) => {
              const Icon = item.icon;
              const label = t(item.labelKey);
              const navTarget = fixedNavTargetsById[item.id];
              const digit = index + 1;

              return (
                <NavContextMenu config={navTarget.contextMenu} key={item.id}>
                  <SidebarMenuItem>
                    {item.kind === "action" ? (
                      <SidebarMenuButton
                        onClick={navTarget.action}
                        tooltip={label}
                      >
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    ) : (
                      <SidebarMenuButton asChild tooltip={label}>
                        <Link
                          activeProps={{ "data-active": true }}
                          to={item.to}
                        >
                          <Icon />
                          <span>{label}</span>
                        </Link>
                      </SidebarMenuButton>
                    )}
                    {(() => {
                      if (showNavBadges) {
                        return <NavBadge digit={digit} />;
                      }
                      if (item.id === "search") {
                        return (
                          <SidebarMenuBadge>
                            <kbd className="text-muted-foreground text-[0.625rem]">
                              {formatHotkeyForPlatform(
                                searchHotkey,
                                hotkeyPlatform,
                              )}
                            </kbd>
                          </SidebarMenuBadge>
                        );
                      }
                      if (item.id === "inbox" && openInboxCount > 0) {
                        return (
                          <SidebarMenuBadge>
                            <span className="text-muted-foreground text-[0.625rem] tabular-nums">
                              {format.number(openInboxCount)}
                            </span>
                          </SidebarMenuBadge>
                        );
                      }
                      if (item.id === "matters" && canCreateMatter) {
                        return (
                          <SidebarMenuAction
                            onClick={handleCreateWorkspace}
                            showOnHover
                            title={t("common.newMatter")}
                          >
                            <PlusIcon />
                          </SidebarMenuAction>
                        );
                      }
                      return null;
                    })()}
                  </SidebarMenuItem>
                </NavContextMenu>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Right-click anywhere below to create a new matter */}
        <SidebarContextArea
          canCreateWorkspace={canCreateMatter}
          onCreateWorkspace={handleCreateWorkspace}
        >
          {/* Pinned */}
          {pinned.length > 0 && (
            <SidebarGroup className="min-h-0 flex-1">
              <SidebarGroupLabel>{t("navigation.pinned")}</SidebarGroupLabel>
              <SidebarGroupContent className={SCROLLABLE_GROUP_CONTENT}>
                <SidebarMenu>
                  {pinned.map((ws, i) => (
                    <MatterItem
                      activeOrganizationId={user.activeOrganizationId}
                      isActive={activeWorkspaceId === ws.id}
                      isExpanded={!isCollapsed && expandedMatterId === ws.id}
                      isPinned
                      key={ws.id}
                      navBadge={
                        showNavBadges && i < 3
                          ? primaryNavItems.length + 1 + i
                          : undefined
                      }
                      onDeleted={handleMatterDeleted}
                      onEntityDrop={handleEntityDropOnMatter}
                      onExpandedChange={() => toggleMatterExpansion(ws.id)}
                      onReorder={reorderPinned}
                      onTogglePin={togglePin}
                      workspace={ws}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {/* Recents — sorted by lastActivityAt. Header intentionally omitted;
              the list reads as the continuation of the matter list above. */}
          {recents.length > 0 && (
            <SidebarGroup className="min-h-0 flex-1">
              <SidebarGroupContent className={SCROLLABLE_GROUP_CONTENT}>
                <SidebarMenu>
                  {recents.map((ws) => (
                    <MatterItem
                      activeOrganizationId={user.activeOrganizationId}
                      isActive={activeWorkspaceId === ws.id}
                      isExpanded={!isCollapsed && expandedMatterId === ws.id}
                      key={ws.id}
                      onDeleted={handleMatterDeleted}
                      onEntityDrop={handleEntityDropOnMatter}
                      onExpandedChange={() => toggleMatterExpansion(ws.id)}
                      onTogglePin={togglePin}
                      workspace={ws}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContextArea>
      </SidebarContent>

      {/* User avatar at bottom */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-expanded={guideDrawerState === GUIDE_DRAWER_STATES.open}
              aria-haspopup="dialog"
              onClick={() => setGuideDrawerState(GUIDE_DRAWER_STATES.open)}
              size="sm"
              tooltip={t("guides.help.buttonLabel")}
            >
              <CircleHelpIcon className="size-4" />
              <span>{t("guides.help.buttonLabel")}</span>
            </SidebarMenuButton>
            {guideDrawerState !== GUIDE_DRAWER_STATES.idle && (
              <Suspense fallback={null}>
                <GuideHelpDrawer
                  onOpenChange={(open) =>
                    setGuideDrawerState(
                      open
                        ? GUIDE_DRAWER_STATES.open
                        : GUIDE_DRAWER_STATES.closed,
                    )
                  }
                  open={guideDrawerState === GUIDE_DRAWER_STATES.open}
                  workspaceId={activeWorkspaceId ?? workspaces?.at(0)?.id}
                  workspaceSelectionPending={workspacesPending}
                />
              </Suspense>
            )}
          </SidebarMenuItem>
          <FeedbackDialog userEmail={user.email} />
          <SidebarUserMenu user={user} />
        </SidebarMenu>
      </SidebarFooter>

      <SearchDialog onOpenChange={setSearchOpen} open={searchOpen} />

      {pendingEntityDrop && (
        <CopyToMatterDialog
          entities={pendingEntityDrop.entities}
          initialTargetWorkspaceId={pendingEntityDrop.targetWorkspaceId}
          onOpenChange={(open) => {
            if (!open) {
              setPendingEntityDrop(null);
            }
          }}
          open
          sourceWorkspaceId={pendingEntityDrop.sourceWorkspaceId}
        />
      )}
    </Sidebar>
  );
};

const RECENTS_LIMIT = 5;
const HOLD_DELAY_MS = 500;

type MatterExpansion =
  | { type: "automatic" }
  | { type: "selected"; workspaceId: string | null };

// Pinned workspaces are local UI state until backend user preferences or a
// workspace-member `pinned` flag exists.

/**
 * Minimum shape required to identify and render a matter.
 * Any component or function that represents a matter must
 * accept this type so `MatterIcon` always has a color.
 */
type MatterIdentity = {
  defaultViewId?: string | null;
  id: string;
  name: string;
  color: string | null;
};

type ContextAction = {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: "destructive";
};

type NavContextMenuConfig = {
  primaryAction?: ContextAction;
  recents?: ContextAction[];
};

const NavContextMenu = ({
  config,
  children,
}: {
  config: NavContextMenuConfig;
  children: React.ReactNode;
}): React.ReactNode => {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const hasRecents = (config.recents?.length ?? 0) > 0;
  const hasContent = config.primaryAction !== undefined || hasRecents;

  if (!hasContent) {
    return children;
  }

  return (
    <div
      className="contents"
      onContextMenu={containedEventHandler((e) => {
        e.preventDefault();
        e.stopPropagation();
        const x = e.clientX;
        const y = e.clientY;
        setAnchor({
          getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
        });
        setOpen(true);
      })}
    >
      {children}
      <Menu
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setAnchor(null);
          }
        }}
        open={open}
      >
        <MenuTrigger
          nativeButton={false}
          render={<span className="sr-only" />}
        />
        <MenuPopup anchor={anchor ?? undefined}>
          {config.primaryAction && (
            <MenuItem onClick={config.primaryAction.onClick}>
              {config.primaryAction.icon}
              {config.primaryAction.label}
            </MenuItem>
          )}
          {hasRecents && config.primaryAction !== undefined && (
            <MenuSeparator />
          )}
          {config.recents?.map((item) => (
            <MenuItem
              className={cn(
                item.variant === "destructive" && "text-destructive",
              )}
              key={item.id}
              onClick={item.onClick}
            >
              {item.icon}
              {item.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
};

const NavBadge = ({
  className,
  digit,
}: {
  className?: string;
  digit: number;
}) => (
  <SidebarMenuBadge className={className}>
    <kbd className="animate-in bg-muted text-muted-foreground fade-in rounded border px-1.5 py-0.5 text-[0.625rem] duration-150 motion-reduce:animate-none">
      {digit}
    </kbd>
  </SidebarMenuBadge>
);

type PendingEntityDrop = {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  entities: CopyToMatterEntity[];
};

type AppSidebarProps = React.ComponentProps<typeof Sidebar>;
type AppSidebarStyle = React.CSSProperties & {
  "--matter-sidebar-tint"?: string;
};

type MatterItemProps = {
  activeOrganizationId: string;
  workspace: MatterIdentity & {
    reference: string | null;
    client?: { id: string; displayName: string } | null;
    lastActivityAt: Date;
  };
  isActive: boolean;
  isPinned?: boolean;
  isExpanded: boolean;
  onExpandedChange: () => void;
  onTogglePin: (id: string) => void;
  /** Navigate-away (or other cleanup) after the matter is deleted; the
   *  delete itself is owned by the shared menu via useMatterActions. */
  onDeleted: (id: string) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
  /** Drop an entity dragged from the open matter's table onto this matter to
   *  open the copy/move dialog pre-targeted here. */
  onEntityDrop?: (
    targetWorkspaceId: string,
    entities: CopyToMatterEntity[],
  ) => void;
  navBadge?: number | undefined;
};

const MATTER_DRAG_TYPE = "stella/pinned-matter-id";

// The entity drag payload shape produced by row-cells.tsx `getInitialData`.
// Matched structurally off the untrusted drop data before mapping into the
// dialog's `CopyToMatterEntity`.
type DraggedEntityPayload = {
  entityId: string;
  name: string;
  kind: EntityKind;
  /** Ancestor entity IDs (immediate parent up to the root), resolved by the
   *  drag source against the full tree so the chain crosses unselected
   *  intermediate folders. Older drag payloads may omit it. */
  ancestorIds?: string[];
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isDraggedEntityPayload = (
  value: unknown,
): value is DraggedEntityPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "entityId" in value &&
    typeof value.entityId === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "kind" in value &&
    typeof value.kind === "string"
  );
};

// Maps the entity drag payload into the `CopyToMatterEntity` shape the
// copy/move dialog consumes. The payload comes from our own draggable, so only
// the array structure is validated.
const toCopyToMatterEntities = (raw: unknown): CopyToMatterEntity[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: CopyToMatterEntity[] = [];
  for (const item of raw) {
    if (!isDraggedEntityPayload(item)) {
      continue;
    }
    result.push({
      entityId: item.entityId,
      entityName: item.name,
      kind: item.kind,
      ancestorIds: isStringArray(item.ancestorIds) ? item.ancestorIds : [],
    });
  }
  return result;
};

const MatterItem = ({
  activeOrganizationId,
  workspace: ws,
  isActive,
  isExpanded,
  isPinned: _isPinnedProp,
  onTogglePin,
  onDeleted,
  onReorder,
  onEntityDrop,
  onExpandedChange,
  navBadge,
}: MatterItemProps) => {
  // Read pin state directly from the store so the menu label
  // updates immediately after toggling (the prop may be stale
  // while the popover is open).
  const isPinned = usePinnedStore((s) => s.isPinned(ws.id));
  const t = useTranslations();
  const { state, setOpen, isMobile } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxAnchor, setCtxAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
  const updateWorkspace = useUpdateWorkspace();
  const dropRef = useRef<HTMLLIElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isEntityDropTarget, setIsEntityDropTarget] = useState(false);
  const rename = useInlineRename({
    initial: ws.name,
    onCommit: (value, { setError }) => {
      if (updateWorkspace.isPending) {
        setError(t("errors.actionFailed"));
        return;
      }
      updateWorkspace.mutate(
        {
          workspaceId: ws.id,
          update: { type: "name", value },
        },
        {
          onError: () => {
            stellaToast.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
  });

  // Read whatever the activity query has already cached for this matter without
  // ever issuing a request: the expanded row owns the fetch, so `enabled: false`
  // keeps the sidebar at its current request count while still re-rendering the
  // disclosure once that fetch resolves.
  const { data: cachedActivity, status: activityStatus } = useInfiniteQuery({
    ...workspaceActivityOptions({
      activeOrganizationId,
      key: { workspaceId: ws.id },
    }),
    enabled: false,
  });
  // `invalidateQueries` does not refetch a disabled observer, so the cached
  // pages can outlive the matter they describe. The invalidation flag lives on
  // the cache entry rather than the observer result, so read it from there.
  const queryClient = useQueryClient();
  const activityQueryKey = workspacesKeys.activity(activeOrganizationId, {
    workspaceId: ws.id,
  });
  const activityQueryHash = hashKey(activityQueryKey);
  const activityIsInvalidated = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) =>
        queryClient.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === activityQueryHash) {
            onStoreChange();
          }
        }),
      [activityQueryHash, queryClient],
    ),
    () => queryClient.getQueryState(activityQueryKey)?.isInvalidated ?? false,
    () => false,
  );
  const activityIsKnownEmpty = matterActivityIsKnownEmpty({
    isInvalidated: activityIsInvalidated,
    pages: cachedActivity?.pages,
    status: activityStatus,
  });

  const canDrag = isPinned && !!onReorder;
  const isCollapsed = state === "collapsed" && !isMobile;

  const handleReorder = useLatestCallback(
    (draggedId: string, targetId: string) => {
      onReorder?.(draggedId, targetId);
    },
  );

  const handleEntityDrop = useLatestCallback(
    (entities: CopyToMatterEntity[]) => {
      onEntityDrop?.(ws.id, entities);
    },
  );

  // Entity drops (files from the open matter's table) are accepted on every
  // matter row; the pinned-reorder draggable + drop target only attaches to
  // draggable (pinned) rows.
  useExternalSyncEffect(() => {
    const el = dropRef.current;
    if (!el) {
      return undefined;
    }

    // A single drop target per element (pragmatic-drag-and-drop forbids more
    // than one) that dispatches by drag type: entity drops (copy/move) on
    // every row, matter-reorder only on draggable (pinned) rows.
    const dropTarget = dropTargetForElements({
      element: el,
      canDrop: ({ source }) => {
        const type = source.data["type"];
        if (type === ENTITY_DRAG_TYPE) {
          // Only entity drags that carry a usable transfer payload (the table
          // rows) are droppable; ENTITY_DRAG_TYPE drags without an `entities`
          // array (e.g. calendar chips) must not highlight as valid targets.
          return toCopyToMatterEntities(source.data["entities"]).length > 0;
        }
        return (
          canDrag &&
          type === MATTER_DRAG_TYPE &&
          source.data["matterId"] !== ws.id
        );
      },
      getData: ({ source }) =>
        withDropAnnouncementData(
          {},
          {
            type:
              source.data["type"] === MATTER_DRAG_TYPE ? "reorder" : "action",
            name: ws.name,
          },
        ),
      onDragEnter: ({ source }) => {
        if (source.data["type"] === ENTITY_DRAG_TYPE) {
          setIsEntityDropTarget(true);
        } else {
          setIsDropTarget(true);
        }
      },
      onDragLeave: ({ source }) => {
        if (source.data["type"] === ENTITY_DRAG_TYPE) {
          setIsEntityDropTarget(false);
        } else {
          setIsDropTarget(false);
        }
      },
      onDrop: ({ source }) => {
        if (source.data["type"] === ENTITY_DRAG_TYPE) {
          setIsEntityDropTarget(false);
          const entities = toCopyToMatterEntities(source.data["entities"]);
          if (entities.length === 0) {
            return;
          }
          handleEntityDrop(entities);
          return;
        }
        setIsDropTarget(false);
        const draggedId = source.data["matterId"];
        if (typeof draggedId !== "string" || draggedId === ws.id) {
          return;
        }
        handleReorder(draggedId, ws.id);
      },
    });

    if (!canDrag) {
      return dropTarget;
    }

    return combine(
      dropTarget,
      draggable({
        element: el,
        getInitialData: () =>
          withDragAnnouncementData(
            { type: MATTER_DRAG_TYPE, matterId: ws.id },
            ws.name,
          ),
      }),
    );
  }, [ws.id, ws.name, canDrag, handleReorder, handleEntityDrop]);

  const relTime = formatRelativeTime(ws.lastActivityAt);
  const navigationTarget = resolveMatterNavigationTarget(ws);

  const startRename = () => {
    setMenuOpen(false);
    setCtxAnchor(null);

    if (isCollapsed) {
      setOpen(true);
      // The sidebar needs a frame to expand before the input can
      // mount visibly; deferring `startEditing` keeps the rename
      // affordance lined up with the now-revealed row.
      window.requestAnimationFrame(() => rename.startEditing());
      return;
    }

    rename.startEditing();
  };

  const { callbacks, dialogs } = useMatterActions(
    {
      id: ws.id,
      name: ws.name,
      color: ws.color,
      client: ws.client ?? null,
    },
    { onRename: startRename, onDeleted: () => onDeleted(ws.id) },
  );

  if (rename.state.mode === "edit") {
    return (
      <SidebarMenuItem>
        <div className="flex h-8 w-full items-center gap-2 rounded-md px-2">
          <MatterIcon
            className="size-4 shrink-0"
            matter={{ id: ws.id, color: ws.color }}
          />
          <Input
            autoFocus
            className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
            onBlur={() => {
              detached(rename.commit(), "app-sidebar.commit");
            }}
            onChange={(e) => rename.setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                rename.cancel();
                e.currentTarget.blur();
              }
            }}
            value={rename.state.draft}
          />
        </div>
      </SidebarMenuItem>
    );
  }

  return (
    <>
      <SidebarMenuItem
        className={cn(
          isDropTarget &&
            "before:bg-primary before:pointer-events-none before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-full",
          isEntityDropTarget &&
            "bg-primary/8 ring-primary rounded-md ring-2 ring-inset",
        )}
        onContextMenu={containedEventHandler((e) => {
          e.preventDefault();
          e.stopPropagation();
          const x = e.clientX;
          const y = e.clientY;
          setCtxAnchor({
            getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
          });
          setMenuOpen(true);
        })}
        ref={dropRef}
      >
        {activityIsKnownEmpty ? null : (
          <Tooltip
            content={isExpanded ? t("common.showLess") : t("common.showMore")}
            render={
              <Button
                aria-controls={`matter-activity-${ws.id}`}
                aria-expanded={isExpanded}
                aria-label={
                  isExpanded ? t("common.showLess") : t("common.showMore")
                }
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute end-1 top-1 z-10 border-0 group-data-[collapsible=icon]:hidden before:hidden focus-visible:ring-1 focus-visible:ring-offset-0"
                onClick={onExpandedChange}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <DirectionalIcon
              className={cn(
                "size-3.5 transition-transform duration-150",
                isExpanded && "rotate-90",
              )}
              flip={!isExpanded}
              icon={ChevronRightIcon}
            />
          </Tooltip>
        )}
        {!isCollapsed && (
          <MatterColorContextPicker
            className="absolute start-2 top-2 z-10 size-4"
            label={t("common.changeColor")}
            matter={ws}
          >
            <MatterIcon
              className="size-4 shrink-0"
              matter={{ id: ws.id, color: ws.color }}
            />
          </MatterColorContextPicker>
        )}
        <SidebarMenuButton
          asChild
          className={cn(
            "py-0 ps-8 group-data-[collapsible=icon]:ps-2",
            activityIsKnownEmpty ? "pe-12" : "pe-20",
          )}
          tooltip={[
            ws.name,
            ws.client?.displayName ?? t("workspaces.parties.personalLabel"),
            ws.reference,
          ]
            .filter(Boolean)
            .join(" — ")}
        >
          <Link data-active={isActive || undefined} {...navigationTarget}>
            {/* Collapsed rail: the icon is the whole item, so it stays
                inside the link (left click navigates) and only right
                click opens the colour picker. */}
            {isCollapsed && (
              <MatterColorContextPicker
                className="size-4"
                matter={ws}
                trigger="contextmenu"
              >
                <MatterIcon
                  className="size-4 shrink-0"
                  matter={{ id: ws.id, color: ws.color }}
                />
              </MatterColorContextPicker>
            )}
            <span className="flex min-w-0 flex-col">
              <BidiText as="span" className="truncate">
                {ws.name}
              </BidiText>
              <Tooltip
                content={formatFullTimestamp(ws.lastActivityAt)}
                render={
                  <span className="text-muted-foreground truncate text-[0.625rem] leading-tight opacity-60 transition-opacity duration-200 group-hover/sidebar-menu-button:opacity-100" />
                }
              >
                <BidiText>
                  {ws.client
                    ? ws.client.displayName
                    : t("workspaces.parties.personalLabel")}
                </BidiText>
                {relTime ? ` · ${relTime}` : ""}
              </Tooltip>
            </span>
          </Link>
        </SidebarMenuButton>
        {navBadge !== undefined ? (
          <NavBadge
            className={cn(!activityIsKnownEmpty && "end-7")}
            digit={navBadge}
          />
        ) : (
          <div
            className={cn(
              "absolute top-1.5 flex items-center gap-0.5 opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 group-data-[collapsible=icon]:hidden data-[pinned]:opacity-100",
              activityIsKnownEmpty ? "end-1" : "end-7",
            )}
            data-pinned={isPinned || undefined}
          >
            <Tooltip
              content={isPinned ? t("common.unpin") : t("common.pin")}
              render={
                <button
                  aria-label={isPinned ? t("common.unpin") : t("common.pin")}
                  className="text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent flex size-5 items-center justify-center rounded-md outline-hidden"
                  onClick={() => onTogglePin(ws.id)}
                  type="button"
                />
              }
            >
              {isPinned ? (
                <PinOffIcon className="size-3.5" />
              ) : (
                <PinIcon className="size-3.5" />
              )}
            </Tooltip>
            <Menu
              onOpenChange={(open) => {
                setMenuOpen(open);
                if (!open) {
                  setCtxAnchor(null);
                }
              }}
              open={menuOpen}
            >
              <MenuTrigger
                aria-label={t("common.actions")}
                className="text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent flex size-5 items-center justify-center rounded-md outline-hidden data-popup-open:opacity-100"
              >
                <EllipsisVerticalIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup
                align="start"
                anchor={ctxAnchor ?? undefined}
                side="right"
                sideOffset={4}
              >
                <MatterMenuHeader
                  clientName={ws.client?.displayName ?? null}
                  color={ws.color}
                  id={ws.id}
                  name={ws.name}
                />
                <MenuSeparator />
                <MatterMenuItems {...callbacks} />
              </MenuPopup>
            </Menu>
          </div>
        )}
        {isExpanded ? (
          <MatterActivityList
            activeOrganizationId={activeOrganizationId}
            id={`matter-activity-${ws.id}`}
            workspaceId={ws.id}
          />
        ) : null}
      </SidebarMenuItem>

      {dialogs}
    </>
  );
};

type MatterActivityListProps = {
  activeOrganizationId: string;
  id: string;
  workspaceId: string;
};

const MatterActivityList = ({
  activeOrganizationId,
  id,
  workspaceId,
}: MatterActivityListProps) => {
  const t = useTranslations();
  const navigate = routeApi.useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const mounted = useHasMounted();
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery({
    ...workspaceActivityOptions({
      activeOrganizationId,
      key: { workspaceId },
    }),
    enabled: mounted,
  });
  const items = data ? data.pages.flatMap((page) => page.items) : [];

  const openEntity = async ({
    entityKind,
    id: entityId,
    title,
  }: (typeof items)[number] & { type: "entity" }) => {
    const destination = resolveEntityActivityDestination(entityKind);
    if (destination.type === "task") {
      useInspectorTabsStore
        .getState()
        .openTask({ taskId: entityId, workspaceId, label: title });
      return;
    }

    if (destination.type === "folder") {
      await navigateToWorkspaceFolder({
        folderId: entityId,
        navigate,
        pathname,
        targetWorkspaceId: workspaceId,
      });
      return;
    }

    if (destination.type === "document") {
      await openEntityInInspector(entityId, title, workspaceId);
      return;
    }

    await navigate({
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId, viewId: "all" },
    });
  };

  if (isPending) {
    return (
      <SidebarMenuSub className="border-0" id={id}>
        {[0, 1, 2].map((index) => (
          <SidebarMenuSubItem key={index}>
            <div className="flex h-7 items-center gap-2 px-2">
              <span className="bg-muted size-3.5 animate-pulse rounded" />
              <span className="bg-muted h-3 flex-1 animate-pulse rounded" />
            </div>
          </SidebarMenuSubItem>
        ))}
      </SidebarMenuSub>
    );
  }

  if (isError) {
    return (
      <SidebarMenuSub className="border-0" id={id}>
        <SidebarMenuSubItem>
          <MatterActivityRow>
            <button
              onClick={() => {
                detached(refetch(), "app-sidebar.refetch");
              }}
              type="button"
            >
              {t("common.tryAgain")}
            </button>
          </MatterActivityRow>
        </SidebarMenuSubItem>
      </SidebarMenuSub>
    );
  }

  // Nothing to disclose: render no list at all rather than an empty one, so the
  // matter row never opens onto a dead end. The row drops its disclosure toggle
  // on the same drained, item-free result. An empty page that still has a
  // continuation keeps the list mounted so its "show more" control stays
  // reachable.
  if (items.length === 0 && !hasNextPage) {
    return null;
  }

  return (
    <SidebarMenuSub className="border-0" id={id}>
      {items.map((item) => {
        const title =
          item.type === "thread" && isPlaceholderThreadTitle(item.title)
            ? t("chat.newChat")
            : item.title;
        const relativeTime = formatRelativeTime(item.activityAt);
        const content = (
          <>
            {item.type === "thread" ? (
              <MessageSquareIcon className="text-muted-foreground size-3.5 shrink-0" />
            ) : (
              <EntityKindIcon
                className="text-muted-foreground size-3.5 shrink-0"
                fileName={item.fileName}
                kind={item.entityKind}
                mimeType={item.mimeType}
                status={item.status}
              />
            )}
            <BidiText as="span" className="min-w-0 flex-1 truncate text-start">
              {title}
            </BidiText>
            {relativeTime ? (
              <Tooltip
                content={formatFullTimestamp(item.activityAt)}
                render={
                  <span className="text-muted-foreground shrink-0 tabular-nums" />
                }
              >
                {relativeTime}
              </Tooltip>
            ) : null}
          </>
        );

        return (
          <SidebarMenuSubItem key={`${item.type}-${item.id}`}>
            {item.type === "thread" ? (
              <MatterActivityRow>
                <Link
                  activeProps={{ "data-active": true }}
                  params={{ threadId: item.id, workspaceId }}
                  to="/chat/workspaces/$workspaceId/$threadId"
                >
                  {content}
                </Link>
              </MatterActivityRow>
            ) : (
              <MatterActivityRow>
                <button
                  onClick={() => {
                    detached(openEntity(item), "app-sidebar.open-entity");
                  }}
                  type="button"
                >
                  {content}
                </button>
              </MatterActivityRow>
            )}
          </SidebarMenuSubItem>
        );
      })}
      {hasNextPage ? (
        <SidebarMenuSubItem>
          <MatterActivityRow className="text-muted-foreground justify-start">
            <button
              disabled={isFetchingNextPage}
              onClick={() => {
                detached(fetchNextPage(), "app-sidebar.fetch-next-page");
              }}
              type="button"
            >
              {isFetchingNextPage ? t("common.loading") : t("common.showMore")}
            </button>
          </MatterActivityRow>
        </SidebarMenuSubItem>
      ) : null}
    </SidebarMenuSub>
  );
};

const SidebarContextArea = ({
  canCreateWorkspace,
  onCreateWorkspace,
  children,
}: {
  canCreateWorkspace: boolean;
  onCreateWorkspace: () => void;
  children?: React.ReactNode;
}) => {
  const t = useTranslations();
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxAnchor, setCtxAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onContextMenu={containedEventHandler((e) => {
        e.preventDefault();
        const x = e.clientX;
        const y = e.clientY;
        setCtxAnchor({
          getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
        });
        setCtxOpen(true);
      })}
    >
      {children}
      <Menu
        onOpenChange={(open) => {
          setCtxOpen(open);
          if (!open) {
            setCtxAnchor(null);
          }
        }}
        open={ctxOpen}
      >
        <MenuTrigger
          nativeButton={false}
          render={<span className="sr-only" />}
        />
        <MenuPopup anchor={ctxAnchor ?? undefined}>
          {canCreateWorkspace && (
            <MenuItem onClick={onCreateWorkspace}>
              <PlusIcon />
              {t("common.newMatter")}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
};

const routeApi = getRouteApi("/_protected");
