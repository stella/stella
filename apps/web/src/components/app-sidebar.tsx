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
  BookOpenIcon,
  ChevronsUpDownIcon,
  ClockIcon,
  EllipsisVerticalIcon,
  GlobeIcon,
  InboxIcon,
  LayersIcon,
  LinkIcon,
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
  TrashIcon,
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
import { getInitials } from "@/lib/get-initials";
import { HOTKEYS, NAV_KEY } from "@/lib/hotkeys";
import { getMatterSwatch } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { knowledgeSections } from "@/routes/_protected.knowledge/index";
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
  useDeleteWorkspace,
  useUpdateWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import {
  workspacesKeys,
  workspacesNavigationOptions,
} from "@/routes/_protected.workspaces/-queries";

const isDev = import.meta.env.DEV;
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
      color: color ? `var(${color})` : `var(${getMatterSwatch(id)})`,
    }}
  />
);

type SidebarTimerPopoverProps = {
  workspaceId: string;
};

type SidebarTimerBadgeProps = {
  workspaceId: string;
};

const SidebarTimerBadge = ({ workspaceId }: SidebarTimerBadgeProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const stopTimer = useStopTimer();
  const { data: activeTimer } = useQuery({
    ...activeTimerOptions(workspaceId),
  });
  const [timerSeconds, setTimerSeconds] = useState(0);

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

  if (activeTimer) {
    return (
      <SidebarMenuBadge>
        <span className="flex items-center gap-1.5 text-xs tabular-nums">
          <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
          {formatTimer(timerSeconds)}
          <Button
            aria-label={t("billing.stopTimer")}
            className="text-muted-foreground size-5"
            disabled={stopTimer.isPending}
            onClick={() => {
              stopTimer.mutate(
                {
                  workspaceId,
                },
                {
                  onSuccess: () => {
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
                      title: t("billing.failedToStopTimer"),
                      type: "error",
                    });
                  },
                },
              );
            }}
            size="icon"
            variant="ghost"
          >
            <SquareIcon className="size-3 fill-current" />
          </Button>
        </span>
      </SidebarMenuBadge>
    );
  }

  return (
    <SidebarMenuBadge>
      <SidebarTimerPopover workspaceId={workspaceId} />
    </SidebarMenuBadge>
  );
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

type ContextAction = {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: "destructive";
};

/**
 * Every nav section declares its context menu via this type.
 * The required fields make it a compile error to add a nav
 * item without considering its right-click experience.
 *
 * - `primaryAction`: the "+ New X" action (null if the section
 *    has no creation flow yet)
 * - `recents`: recent/pinned items shown below the action.
 *    Empty array = no data available yet, but you acknowledged
 *    the field exists. When data becomes available, fill it in.
 */
type NavContextMenuConfig = {
  primaryAction: ContextAction | null;
  recents: ContextAction[];
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

  const hasContent = config.primaryAction !== null || config.recents.length > 0;

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
          {config.recents.length > 0 && config.primaryAction && (
            <MenuSeparator />
          )}
          {config.recents.map((item, i) => (
            // eslint-disable-next-line react/no-array-index-key
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

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  role: Role;
};

type MatterItemProps = {
  workspace: MatterIdentity & {
    reference: string | null;
    client?: { id: string; displayName: string } | null;
    lastActivityAt: Date;
  };
  isPinned?: boolean;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
  navBadge?: number | undefined;
};

const MATTER_DRAG_TYPE = "stella/pinned-matter-id";

const MatterItem = ({
  workspace: ws,
  isPinned,
  onTogglePin,
  onDelete,
  onReorder,
  navBadge,
}: MatterItemProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(ws.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxAnchor, setCtxAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
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
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
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
              <div
                className="max-w-48 border-l-2 px-2 py-1.5"
                style={{
                  borderColor: `var(${ws.color || getMatterSwatch(ws.id)})`,
                }}
              >
                <div className="truncate text-xs font-medium">{ws.name}</div>
                {ws.client && (
                  <div className="text-muted-foreground truncate text-xs">
                    {ws.client.displayName}
                  </div>
                )}
              </div>
              <MenuSeparator />
              <MenuItem onClick={() => onTogglePin(ws.id)}>
                {isPinned ? <PinOffIcon /> : <PinIcon />}
                {isPinned ? t("common.unpin") : t("common.pin")}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setRenameValue(ws.name);
                  setIsRenaming(true);
                }}
              >
                <PencilIcon />
                {t("common.rename")}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  const url = new URL(
                    `/workspaces/${ws.id}`,
                    window.location.origin,
                  );
                  navigator.clipboard.writeText(url.toString()).catch(() => {
                    // Clipboard API may fail if page loses focus
                  });
                }}
              >
                <LinkIcon />
                {t("common.copyLink")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                className="text-destructive"
                onClick={() => onDelete(ws.id)}
              >
                <TrashIcon />
                {t("common.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      )}
    </SidebarMenuItem>
  );
};

const SidebarContextArea = ({
  onCreateWorkspace,
  children,
}: {
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
          <MenuItem onClick={onCreateWorkspace}>
            <PlusIcon />
            {t("navigation.newMatter")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
};

const routeApi = getRouteApi("/_protected");

export function AppSidebar({ role, ...props }: AppSidebarProps) {
  const signOut = useSignOut();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = routeApi.useNavigate();
  const createWorkspace = useCreateWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
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
  const { data: workspacesData } = useQuery(workspacesNavigationOptions);
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

  const handleDeleteWorkspace = (workspaceId: string) => {
    if (deleteWorkspace.isPending) {
      return;
    }

    const toastId = toastManager.add({
      title: t("workspaces.deletingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });

    deleteWorkspace.mutate(
      { workspaceId },
      {
        // eslint-disable-next-line typescript/no-misused-promises
        onSuccess: async () => {
          toastManager.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          });
          await queryClient.invalidateQueries({
            queryKey: workspacesKeys.all,
          });
          if (workspaceMatch?.params.workspaceId === workspaceId) {
            await navigate({ to: "/workspaces" });
          }
        },
        onError: () => {
          toastManager.update(toastId, {
            title: t("errors.failedToDeleteWorkspace"),
            type: "error",
          });
        },
      },
    );
  };

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

  type NavTarget = {
    action: () => void;
    contextMenu: NavContextMenuConfig;
  };

  const recentMatterAction = (ws: MatterIdentity): ContextAction => ({
    label: ws.name,
    icon: <MatterIcon color={ws.color} id={ws.id} />,
    // eslint-disable-next-line typescript/no-misused-promises
    onClick: async () =>
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: ws.id },
      }),
  });

  // Fixed nav items: one entry per sidebar navigation item.
  // The tuple type ensures every sidebar item has a shortcut
  // AND a context menu config (primary action + recents).
  const fixedNavTargets: [
    /* 1: search */ NavTarget,
    /* 2: inbox */ NavTarget,
    /* 3: workspaces */ NavTarget,
    /* 4: chat */ NavTarget,
    /* 5: knowledge */ NavTarget,
    /* 6: time tracking */ NavTarget,
  ] = [
    {
      action: () => setSearchOpen(true),
      contextMenu: {
        primaryAction: {
          label: t("navigation.search"),
          icon: <SearchIcon />,
          onClick: () => setSearchOpen(true),
        },
        recents: [], // TODO: search history
      },
    },
    {
      action: comingSoon,
      contextMenu: {
        primaryAction: {
          label: t("navigation.inbox"),
          icon: <InboxIcon />,
          onClick: comingSoon,
        },
        recents: [], // TODO: inbox items
      },
    },
    {
      // eslint-disable-next-line typescript/no-misused-promises
      action: async () => await navigate({ to: "/workspaces" }),
      contextMenu: {
        primaryAction: {
          label: t("navigation.newMatter"),
          icon: <PlusIcon />,
          onClick: handleCreateWorkspace,
        },
        recents: recents.slice(0, 3).map(recentMatterAction),
      },
    },
    {
      action: comingSoon,
      contextMenu: {
        primaryAction: {
          label: t("chat.newChat"),
          icon: <PlusIcon />,
          // eslint-disable-next-line typescript/no-misused-promises
          onClick: async () => await navigate({ to: "/chat" }),
        },
        recents: [], // TODO: recent chat threads
      },
    },
    {
      // eslint-disable-next-line typescript/no-misused-promises
      action: async () => await navigate({ to: "/knowledge" }),
      contextMenu: {
        primaryAction: null,
        recents: knowledgeSections
          .filter(
            (s): s is typeof s & { to: NonNullable<typeof s.to> } =>
              s.to !== undefined,
          )
          .map((s) => {
            const Icon = s.icon;
            return {
              label: t(`knowledge.sections.${s.key}.title`),
              icon: <Icon />,
              // eslint-disable-next-line typescript/no-misused-promises
              onClick: async () => await navigate({ to: s.to }),
            };
          }),
      },
    },
    {
      // eslint-disable-next-line typescript/no-misused-promises
      action: async () => {
        if (currentWorkspaceId) {
          await navigate({
            to: "/workspaces/$workspaceId/timesheets",
            params: { workspaceId: currentWorkspaceId },
          });
        }
      },
      contextMenu: currentWorkspaceId
        ? {
            primaryAction: {
              label: t("navigation.timeTracking"),
              icon: <ClockIcon />,
              // eslint-disable-next-line typescript/no-misused-promises
              onClick: async () =>
                await navigate({
                  to: "/workspaces/$workspaceId/timesheets",
                  params: { workspaceId: currentWorkspaceId },
                }),
            },
            recents: [], // TODO: recent time entries
          }
        : {
            primaryAction: null,
            recents: [],
          },
    },
  ];

  const navTargets: NavTarget[] = [
    ...fixedNavTargets,
    ...pinned.slice(0, 3).map(
      (ws): NavTarget => ({
        // eslint-disable-next-line typescript/no-misused-promises
        action: async () =>
          await navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId: ws.id },
          }),
        contextMenu: {
          primaryAction: null,
          recents: [],
        },
      }),
    ),
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
            <NavContextMenu config={fixedNavTargets[0].contextMenu}>
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
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[1].contextMenu}>
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
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[2].contextMenu}>
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
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[3].contextMenu}>
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
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[4].contextMenu}>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("navigation.knowledge")}>
                  <Link activeProps={{ "data-active": true }} to="/knowledge">
                    <BookOpenIcon />
                    <span>{t("navigation.knowledge")}</span>
                  </Link>
                </SidebarMenuButton>
                {showNavBadges && <NavBadge digit={5} />}
              </SidebarMenuItem>
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[5].contextMenu}>
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
                ) : currentWorkspaceId ? (
                  <SidebarTimerBadge workspaceId={currentWorkspaceId} />
                ) : null}
              </SidebarMenuItem>
            </NavContextMenu>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator />

        {/* Right-click anywhere below to create a new matter */}
        <SidebarContextArea onCreateWorkspace={handleCreateWorkspace}>
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
                      onDelete={handleDeleteWorkspace}
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
                      onDelete={handleDeleteWorkspace}
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
                  {t("common.sessions")}
                </MenuItem>
                {isDev && <DevSidebarGroup />}
                <MenuSeparator />
                <MenuItem
                  disabled={signOut.isPending}
                  onClick={() => signOut.mutate()}
                >
                  <LogOutIcon />
                  {t("common.signOut")}
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
