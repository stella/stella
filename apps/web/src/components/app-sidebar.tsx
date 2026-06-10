import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  formatForDisplay,
  useHotkey,
  useKeyHold,
} from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useMatch } from "@tanstack/react-router";
import {
  ChevronsUpDownIcon,
  EllipsisVerticalIcon,
  GlobeIcon,
  LayersIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  SunIcon,
  UsersIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { DevSidebarGroup } from "@/components/dev-sidebar-group";
import { FeedbackDialog } from "@/components/feedback-dialog";
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
  SidebarSeparator,
  useSidebar,
} from "@/components/sidebar";
import { StellaWordmark } from "@/components/stella-wordmark";
import { PALETTES, THEMES, useTheme } from "@/components/theme-provider";
import Tooltip from "@/components/tooltip";
import {
  getWorkspacePrimaryNavItems,
  type WorkspacePrimaryNavId,
} from "@/components/workspace-primary-nav";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { usePermissions } from "@/hooks/use-permissions";
import { usePublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { useSignOut } from "@/hooks/use-sign-out";
import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { SIDE_RAIL_ICON_BUTTON_SIZE } from "@/lib/consts";
import { getInitials } from "@/lib/get-initials";
import { HOTKEYS, NAV_KEY } from "@/lib/hotkeys";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import { knowledgeSections } from "@/routes/_protected.knowledge/index";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import {
  MatterMenuHeader,
  MatterMenuItems,
  useMatterActions,
} from "@/routes/_protected.workspaces/-components/matter-context-menu";
import { useUpdateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";

const isDev = import.meta.env.DEV;
const RECENTS_LIMIT = 5;
const HOLD_DELAY_MS = 500;
const CHANGELOG_URL = "https://stll.app/changelog";
// TODO: Persist pinned workspaces on the backend (user
// preference or a `pinned` flag on the workspace member).

/**
 * Minimum shape required to identify and render a matter.
 * Any component or function that represents a matter must
 * accept this type so `MatterIcon` always has a color.
 */
type MatterIdentity = {
  id: string;
  name: string;
  color: string | null;
};

const MatterIcon = ({ id, color }: Pick<MatterIdentity, "id" | "color">) => (
  <LayersIcon
    className="size-4 shrink-0"
    style={{
      color: resolveMatterColor(id, color),
    }}
  />
);

type ContextAction = {
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
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const x = e.clientX;
        const y = e.clientY;
        setAnchor({
          getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
        });
        setOpen(true);
      }}
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
          {config.recents?.map((item, i) => (
            <MenuItem
              className={
                item.variant === "destructive" ? "text-destructive" : undefined
              }
              key={i}
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

const NavBadge = ({ digit }: { digit: number }) => (
  <SidebarMenuBadge>
    <kbd className="animate-in bg-muted text-muted-foreground fade-in rounded border px-1.5 py-0.5 text-[0.625rem] duration-150">
      {digit}
    </kbd>
  </SidebarMenuBadge>
);

type AppSidebarProps = React.ComponentProps<typeof Sidebar>;
type AppSidebarStyle = React.CSSProperties & {
  "--matter-sidebar-tint"?: string;
};

type MatterItemProps = {
  workspace: MatterIdentity & {
    reference: string | null;
    client?: { id: string; displayName: string } | null;
    lastActivityAt: Date;
  };
  isPinned?: boolean;
  onTogglePin: (id: string) => void;
  /** Navigate-away (or other cleanup) after the matter is deleted; the
   *  delete itself is owned by the shared menu via useMatterActions. */
  onDeleted: (id: string) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
  navBadge?: number | undefined;
};

const MATTER_DRAG_TYPE = "stella/pinned-matter-id";

const MatterItem = ({
  workspace: ws,
  isPinned: _isPinnedProp,
  onTogglePin,
  onDeleted,
  onReorder,
  navBadge,
}: MatterItemProps) => {
  // Read pin state directly from the store so the menu label
  // updates immediately after toggling (the prop may be stale
  // while the popover is open).
  const isPinned = usePinnedStore((s) => s.isPinned(ws.id));
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const { state, setOpen, isMobile } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxAnchor, setCtxAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
  const updateWorkspace = useUpdateWorkspace();
  const dropRef = useRef<HTMLLIElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const rename = useInlineRename({
    initial: ws.name,
    onCommit: (value, { setError }) => {
      if (updateWorkspace.isPending) {
        setError(t("errors.actionFailed"));
        return;
      }
      updateWorkspace.mutate(
        { workspaceId: ws.id, name: value },
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

  const canDrag = isPinned && !!onReorder;
  const isCollapsed = state === "collapsed" && !isMobile;

  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    const el = dropRef.current;
    if (!el || !canDrag) {
      return undefined;
    }
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({
          type: MATTER_DRAG_TYPE,
          matterId: ws.id,
        }),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) => source.data["type"] === MATTER_DRAG_TYPE,
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          const draggedId = source.data["matterId"];
          if (typeof draggedId !== "string" || draggedId === ws.id) {
            return;
          }
          onReorderRef.current?.(draggedId, ws.id);
        },
      }),
    );
  }, [ws.id, canDrag]);

  const relTime = formatRelativeTime(ws.lastActivityAt, lang);

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
          <MatterIcon color={ws.color} id={ws.id} />
          <Input
            autoFocus
            className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
            onBlur={() => {
              void rename.commit();
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
        className={
          isDropTarget
            ? "before:bg-primary before:pointer-events-none before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-full"
            : undefined
        }
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const x = e.clientX;
          const y = e.clientY;
          setCtxAnchor({
            getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
          });
          setMenuOpen(true);
        }}
        ref={dropRef}
      >
        <SidebarMenuButton
          asChild
          className="pe-12"
          tooltip={[
            ws.name,
            ws.client?.displayName ?? t("workspaces.parties.personalLabel"),
            ws.reference,
          ]
            .filter(Boolean)
            .join(" — ")}
        >
          <Link
            activeProps={{ "data-active": true }}
            params={{ workspaceId: ws.id }}
            to="/workspaces/$workspaceId"
          >
            <MatterIcon color={ws.color} id={ws.id} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{ws.name}</span>
              <span
                className="text-muted-foreground truncate text-[0.625rem] leading-tight opacity-60 transition-opacity duration-200 group-hover/sidebar-menu-button:opacity-100"
                title={formatFullTimestamp(ws.lastActivityAt, lang)}
              >
                {ws.client
                  ? ws.client.displayName
                  : t("workspaces.parties.personalLabel")}
                {relTime ? ` · ${relTime}` : ""}
              </span>
            </span>
          </Link>
        </SidebarMenuButton>
        {navBadge !== undefined ? (
          <NavBadge digit={navBadge} />
        ) : (
          <div
            className="absolute end-1 top-1.5 flex items-center gap-0.5 opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 group-data-[collapsible=icon]:hidden data-[pinned]:opacity-100"
            data-pinned={isPinned || undefined}
          >
            <button
              className="text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent flex size-5 items-center justify-center rounded-md outline-hidden"
              onClick={() => onTogglePin(ws.id)}
              title={isPinned ? t("common.unpin") : t("common.pin")}
              type="button"
            >
              {isPinned ? (
                <PinOffIcon className="size-3.5" />
              ) : (
                <PinIcon className="size-3.5" />
              )}
            </button>
            <Menu
              onOpenChange={(open) => {
                setMenuOpen(open);
                if (!open) {
                  setCtxAnchor(null);
                }
              }}
              open={menuOpen}
            >
              <MenuTrigger className="text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent flex size-5 items-center justify-center rounded-md outline-hidden data-popup-open:opacity-100">
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
      </SidebarMenuItem>

      {dialogs}
    </>
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
      onContextMenu={(e) => {
        e.preventDefault();
        const x = e.clientX;
        const y = e.clientY;
        setCtxAnchor({
          getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
        });
        setCtxOpen(true);
      }}
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
              {t("navigation.newMatter")}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
};

const routeApi = getRouteApi("/_protected");

export function AppSidebar(props: AppSidebarProps) {
  const signOut = useSignOut();
  const t = useTranslations();
  const navigate = routeApi.useNavigate();
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
  const { state, toggleSidebar, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;
  const publicLawPreviewEnabled = usePublicLawPreviewEnabled();
  const primaryNavItems = getWorkspacePrimaryNavItems({
    includePublicLaw: publicLawPreviewEnabled,
  });
  const { theme, setTheme, palette, setPalette } = useTheme();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const user = routeApi.useRouteContext({
    select: (ctx) => ctx.user,
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const { pinnedOrder, pinnedIds, togglePin, reorderPinned } = usePinnedStore(
    useShallow((s) => ({
      pinnedOrder: s.pinnedOrder,
      pinnedIds: s.pinnedIds,
      togglePin: s.togglePin,
      reorderPinned: s.reorder,
    })),
  );
  const { data: workspacesData } = useQuery(
    workspacesNavigationOptions(user.activeOrganizationId),
  );
  const workspaces = workspacesData?.workspaces;
  const { data: organization } = useQuery(organizationOptions);

  const displayName = user.name ?? user.email;
  const orgName = organization?.name;

  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const activeWorkspaceId = workspaceMatch?.params.workspaceId;
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
      void navigate({ to: "/workspaces" });
    }
  };

  useHotkey(HOTKEYS.SEARCH, () => {
    setSearchOpen((prev) => !prev);
  });

  useHotkey(HOTKEYS.NEW_MATTER, () => {
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

  const recents = useMemo(() => {
    if (!workspaces) {
      return [];
    }
    return [...workspaces]
      .filter((ws) => !pinnedIds.has(ws.id))
      .toSorted(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      )
      .slice(0, RECENTS_LIMIT);
  }, [workspaces, pinnedIds]);

  // Hold-to-reveal nav badges (Control on Mac, Alt on Win/Linux)
  const isNavKeyHeld = useKeyHold(NAV_KEY);
  const [showNavBadges, setShowNavBadges] = useState(false);

  const showBadges = useDebouncedCallback(
    () => setShowNavBadges(true),
    HOLD_DELAY_MS,
  );

  useEffect(() => {
    if (isNavKeyHeld) {
      showBadges();
    } else {
      showBadges.cancel();
      setShowNavBadges(false);
    }
  }, [isNavKeyHeld, showBadges]);

  type NavTarget = {
    action: () => void;
  };

  type FixedNavTarget = NavTarget & {
    contextMenu: NavContextMenuConfig;
  };

  const recentMatterAction = (ws: MatterIdentity): ContextAction => ({
    label: ws.name,
    icon: <MatterIcon color={ws.color} id={ws.id} />,
    onClick: () => {
      void navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: ws.id },
      });
    },
  });

  const openChat = () => {
    void navigate({ to: "/chat" });
  };

  const fixedNavTargetsById = {
    search: {
      action: () => setSearchOpen(true),
      contextMenu: {
        primaryAction: {
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
          label: t("chat.newChat"),
          icon: <PlusIcon />,
          onClick: openChat,
        },
      },
    },
    matters: {
      action: () => {
        void navigate({ to: "/workspaces" });
      },
      contextMenu: {
        primaryAction: {
          label: t("navigation.newMatter"),
          icon: <PlusIcon />,
          onClick: handleCreateWorkspace,
        },
        recents: recents.slice(0, 3).map(recentMatterAction),
      },
    },
    caseLaw: {
      action: () => {
        void navigate({ to: "/law/cases" });
      },
      contextMenu: {},
    },
    knowledge: {
      action: () => {
        void navigate({ to: "/knowledge" });
      },
      contextMenu: {
        recents: knowledgeSections.map((s) => {
          const Icon = s.icon;
          return {
            label: t(`knowledge.sections.${s.key}.title`),
            icon: <Icon />,
            onClick: () => {
              if (s.to) {
                void navigate({ to: s.to });
                return;
              }
              stellaToast.add({
                title: t("common.comingSoon"),
                type: "neutral",
              });
            },
          };
        }),
      },
    },
    contacts: {
      action: () => {
        void navigate({ to: "/contacts" });
      },
      contextMenu: {
        primaryAction: {
          label: t("navigation.contacts"),
          icon: <UsersIcon />,
          onClick: () => {
            void navigate({ to: "/contacts" });
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
    ...pinned.slice(0, 3).map(
      (ws): NavTarget => ({
        action: () => {
          void navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId: ws.id },
          });
        },
      }),
    ),
  ];

  const navTargetsRef = useRef(navTargets);
  navTargetsRef.current = navTargets;

  useEffect(() => {
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
      if (digit >= 1 && digit <= navTargetsRef.current.length) {
        const navTarget = navTargetsRef.current[digit - 1];
        if (navTarget) {
          e.preventDefault();
          navTarget.action();
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showNavBadges]);

  return (
    <Sidebar
      {...props}
      className={cn(
        activeMatterColor &&
          "[&_[data-slot=sidebar-inner]]:bg-[var(--matter-sidebar-tint)]",
        props.className,
      )}
      collapsible="icon"
      style={{ ...sidebarStyle, ...props.style }}
    >
      {/* Stella logo header */}
      <SidebarHeader className="h-12 border-b p-0">
        <div
          className={
            isCollapsed
              ? "flex h-full items-center justify-center"
              : "flex h-full items-center justify-between ps-3 pe-2"
          }
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
                              {formatForDisplay(HOTKEYS.SEARCH)}
                            </kbd>
                          </SidebarMenuBadge>
                        );
                      }
                      if (item.id === "matters" && canCreateMatter) {
                        return (
                          <SidebarMenuAction
                            onClick={handleCreateWorkspace}
                            showOnHover
                            title={t("navigation.newMatter")}
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
              <SidebarGroupContent className="overflow-x-hidden overflow-y-auto">
                <SidebarMenu>
                  {pinned.map((ws, i) => (
                    <MatterItem
                      isPinned
                      key={ws.id}
                      navBadge={
                        showNavBadges && i < 3
                          ? primaryNavItems.length + 1 + i
                          : undefined
                      }
                      onDeleted={handleMatterDeleted}
                      onReorder={reorderPinned}
                      onTogglePin={togglePin}
                      workspace={ws}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {/* Recents — sorted by lastActivityAt */}
          {recents.length > 0 && (
            <SidebarGroup className="min-h-0 flex-1">
              <SidebarGroupLabel>{t("navigation.recents")}</SidebarGroupLabel>
              <SidebarGroupContent className="overflow-x-hidden overflow-y-auto">
                <SidebarMenu>
                  {recents.map((ws) => (
                    <MatterItem
                      key={ws.id}
                      onDeleted={handleMatterDeleted}
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
          <FeedbackDialog userEmail={user.email} />
          <SidebarMenuItem>
            <Menu>
              <Tooltip
                content={isCollapsed ? displayName : null}
                render={
                  <MenuTrigger
                    className={cn(
                      "hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent flex w-full items-center overflow-hidden rounded-md p-2 text-start text-sm outline-hidden",
                      isCollapsed ? "justify-center" : "gap-2",
                    )}
                  />
                }
                side="right"
              >
                <Avatar className="size-7 rounded-full">
                  {user.image && <AvatarImage src={user.image} />}
                  <AvatarFallback className="text-[0.625rem]">
                    {getInitials(displayName)}
                  </AvatarFallback>
                </Avatar>
                {!isCollapsed && (
                  <>
                    <div className="flex min-w-0 flex-col justify-center">
                      {user.name ? (
                        <>
                          <span className="truncate text-sm font-medium">
                            {user.name}
                          </span>
                          {user.email && (
                            <span className="text-muted-foreground truncate text-xs">
                              {user.email}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="truncate text-sm font-medium">
                          {user.email || t("common.user")}
                        </span>
                      )}
                    </div>
                    <ChevronsUpDownIcon className="ms-auto size-4 opacity-50" />
                  </>
                )}
              </Tooltip>
              <MenuPopup align="end" className="w-56" side="top" sideOffset={8}>
                {orgName && (
                  <>
                    <MenuGroup>
                      <MenuGroupLabel className="text-sm">
                        {orgName}
                      </MenuGroupLabel>
                    </MenuGroup>
                    <MenuSeparator />
                  </>
                )}
                <MenuItem
                  onClick={() => {
                    void navigate({
                      to: "/settings",
                    });
                  }}
                >
                  <Settings2Icon />
                  {t("common.settings")}
                </MenuItem>
                <MenuSeparator />
                <MenuSub>
                  <MenuSubTrigger>
                    <SunIcon />
                    {t("appearance.title")}
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuGroup>
                      <MenuGroupLabel>{t("appearance.theme")}</MenuGroupLabel>
                      <MenuRadioGroup value={theme}>
                        {THEMES.map((themeOption) => (
                          <MenuRadioItem
                            key={themeOption}
                            onClick={() => setTheme(themeOption)}
                            value={themeOption}
                          >
                            <div className="flex items-center gap-1.5">
                              {
                                {
                                  light: <SunIcon />,
                                  dark: <MoonIcon />,
                                  system: <MonitorIcon />,
                                }[themeOption]
                              }
                              {t(`appearance.${themeOption}`)}
                            </div>
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>{t("appearance.palette")}</MenuGroupLabel>
                      <MenuRadioGroup value={palette}>
                        {PALETTES.map((p) => (
                          <MenuRadioItem
                            key={p}
                            onClick={() => setPalette(p)}
                            value={p}
                          >
                            {t(`appearance.${p}`)}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
                <MenuSub>
                  <MenuSubTrigger>
                    <GlobeIcon />
                    {t("common.language")}
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuRadioGroup value={lang}>
                      {supportedLanguages.map((langCode) => (
                        <MenuRadioItem
                          key={langCode}
                          onClick={() => void setLang(langCode)}
                          value={langCode}
                        >
                          {LANG_ENDONYMS[langCode]}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
                {isDev && <DevSidebarGroup />}
                <MenuSeparator />
                <MenuItem
                  disabled={signOut.isPending}
                  onClick={() => signOut.mutate()}
                >
                  <LogOutIcon />
                  {t("common.signOut")}
                </MenuItem>
                <MenuItem
                  aria-label={t("selfhost.viewReleaseNotes")}
                  className="text-foreground-ghost data-highlighted:text-foreground min-h-0 px-2 pt-1.5 pb-1 text-[0.6875rem] tabular-nums"
                  label={t("selfhost.viewReleaseNotes")}
                  nativeButton={false}
                  render={
                    <a
                      aria-label={t("selfhost.viewReleaseNotes")}
                      href={CHANGELOG_URL}
                      rel="noopener"
                      target="_blank"
                    />
                  }
                >
                  v{__APP_VERSION__} · {__APP_COMMIT_SHA__.slice(0, 12)}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SearchDialog onOpenChange={setSearchOpen} open={searchOpen} />
    </Sidebar>
  );
}
