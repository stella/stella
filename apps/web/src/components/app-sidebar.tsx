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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useMatch } from "@tanstack/react-router";
import {
  BarChart3Icon,
  BookmarkIcon,
  BookOpenIcon,
  ChevronsUpDownIcon,
  ClockIcon,
  EllipsisVerticalIcon,
  FileTextIcon,
  GlobeIcon,
  InboxIcon,
  LayersIcon,
  Loader2Icon,
  LogOutIcon,
  MailIcon,
  MessageCircleIcon,
  MonitorIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  PanelLeftIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  SquareIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import { Button } from "@stella/ui/components/button";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stella/ui/components/combobox";
import { Input } from "@stella/ui/components/input";
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
} from "@stella/ui/components/menu";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

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
import { useSignOut } from "@/hooks/use-sign-out";
import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import type { Role } from "@/lib/auth";
import { HOTKEYS, NAV_KEY } from "@/lib/hotkeys";
import { getMatterSwatch } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { managementRoles } from "@/routes/_protected.organization/-consts";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import {
  useStartTimer,
  useStopTimer,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/time-entries";
import { entitySummariesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  activeTimerOptions,
  timeEntriesKeys,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";
import {
  useCreateWorkspace,
  useUpdateWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

const isDev = import.meta.env.DEV;
const WHITESPACE = /\s+/;
const RECENTS_LIMIT = 5;
const HOLD_DELAY_MS = 500;
// TODO: Persist pinned workspaces on the backend (user
// preference or a `pinned` flag on the workspace member).

const formatTimer = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
};

const MatterIcon = ({ id, color }: { id: string; color?: string | null }) => (
  <LayersIcon
    className="size-4 shrink-0"
    style={{
      color: color ? `var(${color})` : `var(${getMatterSwatch(id)})`,
    }}
  />
);

type SidebarTimerPopoverProps = {
  workspaceId: string;
};

const SidebarTimerPopover = ({ workspaceId }: SidebarTimerPopoverProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedMatterId, setSelectedMatterId] = useState("");
  const startTimer = useStartTimer();

  const { data: matters, isPending: entitiesLoading } = useQuery({
    ...entitySummariesOptions(workspaceId),
    enabled: open,
  });

  const handleStart = () => {
    if (!selectedMatterId) {
      toastManager.add({
        title: t("billing.matterRequired"),
        type: "error",
      });
      return;
    }

    startTimer.mutate(
      {
        workspaceId,
        matterId: selectedMatterId,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // TODO(phase-2): resolve rate from user/matter settings
        rateAtEntry: 0,
        currency: "USD",
      },
      {
        onSuccess: () => {
          setOpen(false);
          setSelectedMatterId("");
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: timeEntriesKeys.all(workspaceId),
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: timeEntriesKeys.activeTimer(workspaceId),
          });
        },
        onError: () => {
          toastManager.add({
            title: t("billing.failedToStartTimer"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSelectedMatterId("");
        }
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label={t("billing.startTimer")}
            className="size-5"
            size="icon"
            title={t("billing.startTimer")}
            variant="ghost"
          />
        }
      >
        <PlayIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-64" side="right" sideOffset={8}>
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-xs">
            {t("billing.selectMatterToStart")}
          </p>
          {entitiesLoading && (
            <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
              <Loader2Icon className="size-3 animate-spin" />
              {t("billing.loading")}
            </div>
          )}
          <Combobox
            onValueChange={(val) => {
              if (val) {
                setSelectedMatterId(String(val));
              }
            }}
            value={selectedMatterId || null}
          >
            <ComboboxInput placeholder={t("billing.selectMatter")} size="sm" />
            <ComboboxPopup>
              <ComboboxList>
                {matters?.map((matter) => (
                  <ComboboxItem key={matter.id} value={matter.id}>
                    {matter.name ?? t("workspaces.defaultName")}
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxPopup>
          </Combobox>
          <Button
            disabled={!selectedMatterId || startTimer.isPending}
            onClick={handleStart}
            size="sm"
          >
            {t("billing.startTimer")}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

const NavBadge = ({ digit }: { digit: number }) => (
  <SidebarMenuBadge>
    <kbd className="animate-in bg-muted text-muted-foreground fade-in rounded border px-1.5 py-0.5 text-[0.625rem] duration-150">
      {digit}
    </kbd>
  </SidebarMenuBadge>
);

const getInitials = (name: string) => {
  const parts = name.trim().split(WHITESPACE);
  const first = parts.at(0);
  const second = parts.at(1);
  if (first && second) {
    return `${first[0]}${second[0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
};

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  role: Role;
};

type MatterItemProps = {
  workspace: {
    id: string;
    name: string;
    reference: string | null;
    color: string | null;
    client?: { id: string; displayName: string } | null;
    lastActivityAt: Date;
  };
  isPinned?: boolean;
  onTogglePin: (id: string) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
  navBadge?: number;
};

const MATTER_DRAG_TYPE = "stella/pinned-matter-id";

const MatterItem = ({
  workspace: ws,
  isPinned,
  onTogglePin,
  onReorder,
  navBadge,
}: MatterItemProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(ws.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const updateWorkspace = useUpdateWorkspace();
  const escapedRef = useRef(false);
  const dropRef = useRef<HTMLLIElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);

  const canDrag = isPinned && !!onReorder;

  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    const el = dropRef.current;
    if (!el || !canDrag) {
      return;
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
        canDrop: ({ source }) => source.data.type === MATTER_DRAG_TYPE,
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          // SAFETY: matterId is always a string; set by our own draggable getInitialData.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const draggedId = source.data.matterId as string;
          if (draggedId !== ws.id) {
            onReorderRef.current?.(draggedId, ws.id);
          }
        },
      }),
    );
  }, [ws.id, canDrag]);

  const relTime = formatRelativeTime(ws.lastActivityAt, lang);

  const cancelRename = () => {
    setIsRenaming(false);
    setRenameValue(ws.name);
  };

  const handleRename = () => {
    if (escapedRef.current) {
      escapedRef.current = false;
      cancelRename();
      return;
    }

    if (updateWorkspace.isPending) {
      return;
    }

    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === ws.name) {
      cancelRename();
      return;
    }

    updateWorkspace.mutate(
      { workspaceId: ws.id, name: trimmed },
      {
        onSuccess: () => setIsRenaming(false),
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
          cancelRename();
        },
      },
    );
  };

  if (isRenaming) {
    return (
      <SidebarMenuItem>
        <div className="flex h-8 w-full items-center gap-2 rounded-md px-2">
          <MatterIcon color={ws.color} id={ws.id} />
          <Input
            autoFocus
            className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
            onBlur={handleRename}
            onChange={(e) => setRenameValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                escapedRef.current = true;
                e.currentTarget.blur();
              }
            }}
            value={renameValue}
          />
        </div>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem
      className={
        isDropTarget
          ? "before:bg-primary before:pointer-events-none before:absolute before:inset-x-2 before:top-0 before:h-0.5 before:rounded-full"
          : undefined
      }
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      ref={dropRef}
    >
      <SidebarMenuButton
        asChild
        className="pe-12"
        tooltip={[ws.name, ws.client?.displayName, ws.reference]
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
            {ws.client ? (
              <span className="text-muted-foreground truncate text-[0.625rem] leading-tight opacity-60 transition-opacity duration-200 group-hover/sidebar-menu-button:opacity-100">
                {ws.client.displayName}
                {relTime ? ` · ${relTime}` : ""}
              </span>
            ) : (
              <span className="text-muted-foreground font-mono text-[0.625rem] leading-tight opacity-60 transition-opacity duration-200 group-hover/sidebar-menu-button:opacity-100">
                {ws.reference ? `${ws.reference} · ${relTime}` : relTime}
              </span>
            )}
          </span>
        </Link>
      </SidebarMenuButton>
      {navBadge !== undefined ? (
        <NavBadge digit={navBadge} />
      ) : (
        <div
          className="absolute end-1 top-1.5 flex items-center gap-0.5 opacity-0 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[pinned]:opacity-100"
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
          <Menu onOpenChange={setMenuOpen} open={menuOpen}>
            <MenuTrigger className="text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent flex size-5 items-center justify-center rounded-md outline-hidden data-popup-open:opacity-100">
              <EllipsisVerticalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="start" side="right" sideOffset={4}>
              <MenuItem
                onClick={() => {
                  setRenameValue(ws.name);
                  setIsRenaming(true);
                }}
              >
                <PencilIcon />
                {t("common.rename")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      )}
    </SidebarMenuItem>
  );
};

const routeApi = getRouteApi("/_protected");

export function AppSidebar({ role, ...props }: AppSidebarProps) {
  const signOut = useSignOut();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = routeApi.useNavigate();
  const createWorkspace = useCreateWorkspace();
  const { state, toggleSidebar, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;
  const { theme, setTheme, palette, setPalette } = useTheme();
  const lang = useI18nStore((s) => s.lang);
  const setLang = useI18nStore((s) => s.setLang);
  const user = routeApi.useRouteContext({
    select: (ctx) => ctx.user,
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const pinnedOrder = usePinnedStore((s) => s.pinnedOrder);
  const pinnedIds = usePinnedStore((s) => s.pinnedIds);
  const togglePin = usePinnedStore((s) => s.togglePin);
  const reorderPinned = usePinnedStore((s) => s.reorder);
  const initPinned = usePinnedStore((s) => s.init);
  useEffect(() => {
    initPinned(user.id);
  }, [initPinned, user.id]);
  const { data: workspacesData } = useQuery(workspacesOptions);
  const workspaces = workspacesData?.workspaces;
  const { data: organization } = useQuery(organizationOptions);

  const displayName = user.name ?? user.email;
  const orgName = organization?.name;

  // Active timer: try to detect current workspace
  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const currentWorkspaceId =
    workspaceMatch?.params.workspaceId ?? workspaces?.at(0)?.id;

  useHotkey(HOTKEYS.SEARCH, () => {
    setSearchOpen((prev) => !prev);
  });

  useHotkey(HOTKEYS.NEW_MATTER, () => {
    handleCreateWorkspace();
  });

  // eslint-disable-next-line typescript/no-misused-promises
  useHotkey(HOTKEYS.TOGGLE_TIME_TRACKING, async () => {
    if (currentWorkspaceId) {
      await navigate({
        to: `/workspaces/${currentWorkspaceId}/timesheets`,
      });
    }
  });

  const { data: activeTimer } = useQuery({
    ...activeTimerOptions(currentWorkspaceId ?? ""),
    enabled: !!currentWorkspaceId,
  });

  const [timerSeconds, setTimerSeconds] = useState(0);
  const stopTimer = useStopTimer();

  // Client-side timer tick
  useEffect(() => {
    if (!activeTimer?.timerStartedAt) {
      setTimerSeconds(0);
      return;
    }
    const startMs = new Date(activeTimer.timerStartedAt).getTime();
    const tick = () => {
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      setTimerSeconds(elapsed);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [activeTimer?.timerStartedAt]);

  const pinned = useMemo(() => {
    if (!workspaces) {
      return [];
    }
    const wsMap = new Map(workspaces.map((ws) => [ws.id, ws]));
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

  const comingSoon = () => {
    toastManager.add({
      title: t("common.comingSoon"),
      type: "foreground",
    });
  };

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

  type NavTarget = { action: () => void };

  // Fixed nav items: one entry per sidebar navigation item.
  // The tuple type ensures every sidebar item has a shortcut.
  const fixedNavTargets: [
    /* 1: search */ NavTarget,
    /* 2: inbox */ NavTarget,
    /* 3: workspaces */ NavTarget,
    /* 4: chat */ NavTarget,
    /* 5: knowledge */ NavTarget,
    /* 6: time tracking */ NavTarget,
  ] = [
    { action: () => setSearchOpen(true) },
    { action: comingSoon },
    // eslint-disable-next-line typescript/no-misused-promises
    { action: async () => await navigate({ to: "/workspaces" }) },
    { action: comingSoon },
    // eslint-disable-next-line typescript/no-misused-promises
    { action: async () => await navigate({ to: "/knowledge" }) },
    {
      // eslint-disable-next-line typescript/no-misused-promises
      action: async () => {
        if (currentWorkspaceId) {
          await navigate({
            to: `/workspaces/${currentWorkspaceId}/timesheets`,
          });
        }
      },
    },
  ];

  const navTargets: NavTarget[] = [
    ...fixedNavTargets,
    ...pinned.slice(0, 3).map((ws) => ({
      action: async () =>
        await navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: ws.id },
        }),
    })),
  ];

  const navTargetsRef = useRef(navTargets);
  navTargetsRef.current = navTargets;

  useEffect(() => {
    if (!showNavBadges) {
      return;
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
        e.preventDefault();
        navTargetsRef.current[digit - 1].action();
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showNavBadges]);

  const handleCreateWorkspace = () => {
    if (createWorkspace.isPending) {
      return;
    }
    createWorkspace.mutate(undefined, {
      onError: () => {
        toastManager.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
      },
    });
  };

  return (
    <Sidebar {...props} collapsible="icon">
      {/* Stella logo header */}
      <SidebarHeader>
        <div
          className={
            isCollapsed
              ? "flex items-center justify-center"
              : "flex items-center justify-between ps-2"
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
        {/* Top navigation */}
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setSearchOpen(true)}
                tooltip={t("navigation.search")}
              >
                <SearchIcon />
                <span>{t("navigation.search")}</span>
              </SidebarMenuButton>
              {showNavBadges ? (
                <NavBadge digit={1} />
              ) : (
                <SidebarMenuBadge>
                  <kbd className="text-muted-foreground text-[0.625rem]">
                    {formatForDisplay(HOTKEYS.SEARCH)}
                  </kbd>
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={comingSoon}
                tooltip={t("navigation.inbox")}
              >
                <InboxIcon />
                <span>{t("navigation.inbox")}</span>
              </SidebarMenuButton>
              {showNavBadges ? (
                <NavBadge digit={2} />
              ) : (
                <SidebarMenuBadge>
                  <span className="bg-muted-foreground/40 size-1.5 rounded-full" />
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={t("common.matters")}>
                <Link activeProps={{ "data-active": true }} to="/workspaces">
                  <LayersIcon />
                  <span>{t("common.matters")}</span>
                </Link>
              </SidebarMenuButton>
              {showNavBadges ? (
                <NavBadge digit={3} />
              ) : (
                <SidebarMenuAction
                  onClick={handleCreateWorkspace}
                  showOnHover
                  title={t("navigation.newMatter")}
                >
                  <PlusIcon />
                </SidebarMenuAction>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                // eslint-disable-next-line typescript/no-misused-promises
                onClick={async () => await navigate({ to: "/chat" })}
                tooltip={t("navigation.chat")}
              >
                <MessageCircleIcon />
                <span>{t("navigation.chat")}</span>
              </SidebarMenuButton>
              {showNavBadges && <NavBadge digit={4} />}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={t("navigation.knowledge")}>
                <Link activeProps={{ "data-active": true }} to="/knowledge">
                  <BookOpenIcon />
                  <span>{t("navigation.knowledge")}</span>
                </Link>
              </SidebarMenuButton>
              {showNavBadges && <NavBadge digit={5} />}
            </SidebarMenuItem>
            <SidebarMenuItem>
              {currentWorkspaceId ? (
                <SidebarMenuButton
                  asChild
                  tooltip={t("navigation.timeTracking")}
                >
                  <Link
                    params={{
                      workspaceId: currentWorkspaceId,
                    }}
                    to="/workspaces/$workspaceId/timesheets"
                  >
                    <ClockIcon />
                    <span>{t("navigation.timeTracking")}</span>
                  </Link>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton
                  onClick={comingSoon}
                  tooltip={t("navigation.timeTracking")}
                >
                  <ClockIcon />
                  <span>{t("navigation.timeTracking")}</span>
                </SidebarMenuButton>
              )}
              {showNavBadges ? (
                <NavBadge digit={6} />
              ) : activeTimer ? (
                <SidebarMenuBadge>
                  <span className="flex items-center gap-1.5 text-xs tabular-nums">
                    <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
                    {formatTimer(timerSeconds)}
                    <Button
                      aria-label={t("billing.stopTimer")}
                      className="text-muted-foreground size-5"
                      disabled={stopTimer.isPending}
                      onClick={() => {
                        if (currentWorkspaceId) {
                          stopTimer.mutate(
                            {
                              workspaceId: currentWorkspaceId,
                            },
                            {
                              onSuccess: () => {
                                // eslint-disable-next-line typescript/no-floating-promises
                                queryClient.invalidateQueries({
                                  queryKey:
                                    timeEntriesKeys.all(currentWorkspaceId),
                                });
                                // eslint-disable-next-line typescript/no-floating-promises
                                queryClient.invalidateQueries({
                                  queryKey:
                                    timeEntriesKeys.activeTimer(
                                      currentWorkspaceId,
                                    ),
                                });
                              },
                              onError: () => {
                                toastManager.add({
                                  title: t("billing.failedToStopTimer"),
                                  type: "error",
                                });
                              },
                            },
                          );
                        }
                      }}
                      size="icon"
                      variant="ghost"
                    >
                      <SquareIcon className="size-3 fill-current" />
                    </Button>
                  </span>
                </SidebarMenuBadge>
              ) : (
                currentWorkspaceId && (
                  <SidebarMenuBadge>
                    <SidebarTimerPopover workspaceId={currentWorkspaceId} />
                  </SidebarMenuBadge>
                )
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              {currentWorkspaceId ? (
                <SidebarMenuButton asChild tooltip={t("navigation.analytics")}>
                  <Link
                    params={{
                      workspaceId: currentWorkspaceId,
                    }}
                    to="/workspaces/$workspaceId/analytics"
                  >
                    <BarChart3Icon />
                    <span>{t("navigation.analytics")}</span>
                  </Link>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton
                  onClick={comingSoon}
                  tooltip={t("navigation.analytics")}
                >
                  <BarChart3Icon />
                  <span>{t("navigation.analytics")}</span>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              {currentWorkspaceId ? (
                <SidebarMenuButton asChild tooltip={t("navigation.invoices")}>
                  <Link
                    params={{
                      workspaceId: currentWorkspaceId,
                    }}
                    to="/workspaces/$workspaceId/invoices"
                  >
                    <FileTextIcon />
                    <span>{t("navigation.invoices")}</span>
                  </Link>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton
                  onClick={comingSoon}
                  tooltip={t("navigation.invoices")}
                >
                  <FileTextIcon />
                  <span>{t("navigation.invoices")}</span>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={t("navigation.caseLaw")}>
                <Link
                  activeProps={{ "data-active": true }}
                  to="/knowledge/case-law"
                >
                  <BookmarkIcon />
                  <span>{t("navigation.caseLaw")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Pinned */}
        {pinned.length > 0 && (
          <SidebarGroup className="min-h-0 flex-1">
            <SidebarGroupLabel>{t("navigation.pinned")}</SidebarGroupLabel>
            <SidebarGroupContent className="overflow-y-auto">
              <SidebarMenu>
                {pinned.map((ws, i) => (
                  <MatterItem
                    isPinned
                    key={ws.id}
                    navBadge={showNavBadges && i < 3 ? 7 + i : undefined}
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
            <SidebarGroupContent className="overflow-y-auto">
              <SidebarMenu>
                {recents.map((ws) => (
                  <MatterItem
                    key={ws.id}
                    onTogglePin={togglePin}
                    workspace={ws}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      {/* User avatar at bottom */}
      <SidebarFooter>
        <SidebarMenu>
          <FeedbackDialog />
          <SidebarMenuItem>
            <Menu>
              <MenuTrigger
                className={cn(
                  "hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent flex w-full items-center overflow-hidden rounded-md p-2 text-start text-sm outline-hidden",
                  isCollapsed ? "justify-center" : "gap-2",
                )}
                title={isCollapsed ? displayName : undefined}
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
              </MenuTrigger>
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
                {managementRoles.includes(role) && (
                  <>
                    <MenuItem
                      // eslint-disable-next-line typescript/no-misused-promises
                      onClick={async () => {
                        await navigate({
                          to: "/organization/members",
                        });
                      }}
                    >
                      <UsersIcon />
                      {t("navigation.members")}
                    </MenuItem>
                    <MenuItem
                      // eslint-disable-next-line typescript/no-misused-promises
                      onClick={async () => {
                        await navigate({
                          to: "/organization/invitations",
                        });
                      }}
                    >
                      <MailIcon />
                      {t("navigation.invitations")}
                    </MenuItem>
                    <MenuSeparator />
                  </>
                )}
                <MenuItem
                  // eslint-disable-next-line typescript/no-misused-promises
                  onClick={async () => {
                    await navigate({
                      to: "/contacts",
                    });
                  }}
                >
                  <UsersIcon />
                  {t("navigation.contacts")}
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
                          onClick={() => setLang(langCode)}
                          value={langCode}
                        >
                          {LANG_ENDONYMS[langCode]}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
                <MenuItem
                  // eslint-disable-next-line typescript/no-misused-promises
                  onClick={async () => {
                    await navigate({
                      to: "/account/settings",
                    });
                  }}
                >
                  <Settings2Icon />
                  {t("common.settings")}
                </MenuItem>
                <MenuItem
                  // eslint-disable-next-line typescript/no-misused-promises
                  onClick={async () => {
                    await navigate({
                      to: "/account/sessions",
                    });
                  }}
                >
                  <MonitorSmartphoneIcon />
                  {t("navigation.sessions")}
                </MenuItem>
                {isDev && <DevSidebarGroup />}
                <MenuSeparator />
                <MenuItem
                  disabled={signOut.isPending}
                  onClick={() => signOut.mutate()}
                >
                  <LogOutIcon />
                  {t("auth.signOut")}
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
