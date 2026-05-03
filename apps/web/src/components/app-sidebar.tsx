import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
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
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
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
  LayersIcon,
  Loader2Icon,
  LogOutIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
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
import { usePermissions } from "@/hooks/use-permissions";
import { useSignOut } from "@/hooks/use-sign-out";
import {
  LANG_ENDONYMS,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import { getInitials } from "@/lib/get-initials";
import { HOTKEYS, NAV_KEY } from "@/lib/hotkeys";
import { resolveMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import { knowledgeSections } from "@/routes/_protected.knowledge/index";
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
  AddMemberDialog,
  MatterMenuItems,
} from "@/routes/_protected.workspaces/-components/matter-context-menu";
import {
  useArchiveWorkspace,
  useDeleteWorkspace,
  useUpdateWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import {
  workspacesKeys,
  workspacesNavigationOptions,
} from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";

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
      color: resolveMatterColor(id, color),
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
      return undefined;
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
                setSelectedMatterId(val);
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

type AppSidebarProps = React.ComponentProps<typeof Sidebar>;

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
  isPinned: _isPinnedProp,
  onTogglePin,
  onDelete,
  onReorder,
  navBadge,
}: MatterItemProps) => {
  // Read pin state directly from the store so the menu label
  // updates immediately after toggling (the prop may be stale
  // while the popover is open).
  const isPinned = usePinnedStore((s) => s.isPinned(ws.id));
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(ws.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [ctxAnchor, setCtxAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);
  const updateWorkspace = useUpdateWorkspace();
  const archiveWorkspace = useArchiveWorkspace();
  const escapedRef = useRef(false);
  const dropRef = useRef<HTMLLIElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);

  const canDrag = isPinned && !!onReorder;

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
          // SAFETY: matterId is always a string; set by our own draggable getInitialData.
          // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
          const draggedId = source.data["matterId"] as string;
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
                <span
                  className="text-muted-foreground truncate text-[0.625rem] leading-tight opacity-60 transition-opacity duration-200 group-hover/sidebar-menu-button:opacity-100"
                  title={formatFullTimestamp(ws.lastActivityAt, lang)}
                >
                  {ws.client.displayName}
                  {relTime ? ` · ${relTime}` : ""}
                </span>
              ) : (
                <span
                  className="text-muted-foreground font-mono text-[0.625rem] leading-tight opacity-60 transition-opacity duration-200 group-hover/sidebar-menu-button:opacity-100"
                  title={formatFullTimestamp(ws.lastActivityAt, lang)}
                >
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
                  className="max-w-48 border-s-2 px-2 py-1.5"
                  style={{
                    borderColor: resolveMatterColor(ws.id, ws.color),
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
                <MatterMenuItems
                  isArchived={false}
                  isPinned={isPinned}
                  onAddMember={() => setAddMemberOpen(true)}
                  onArchive={() =>
                    archiveWorkspace.mutate(
                      { workspaceId: ws.id },
                      {
                        onError: () => {
                          toastManager.add({
                            title: t("errors.actionFailed"),
                            type: "error",
                          });
                        },
                      },
                    )
                  }
                  onCopyLink={() => {
                    void (async () => {
                      try {
                        const url = `${window.location.origin}/workspaces/${ws.id}`;
                        await navigator.clipboard.writeText(url);
                        toastManager.add({
                          title: t("common.copied"),
                          type: "success",
                        });
                      } catch {
                        toastManager.add({
                          title: t("errors.actionFailed"),
                          type: "error",
                        });
                      }
                    })();
                  }}
                  onDelete={() => onDelete(ws.id)}
                  onOpenInNewTab={() => {
                    void window.open(`/workspaces/${ws.id}`, "_blank");
                  }}
                  onRename={() => {
                    setRenameValue(ws.name);
                    setIsRenaming(true);
                  }}
                  onTogglePin={() => onTogglePin(ws.id)}
                />
              </MenuPopup>
            </Menu>
          </div>
        )}
      </SidebarMenuItem>

      {addMemberOpen && (
        <AddMemberDialog
          onOpenChange={setAddMemberOpen}
          open={addMemberOpen}
          workspaceId={ws.id}
        />
      )}
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
  const queryClient = useQueryClient();
  const navigate = routeApi.useNavigate();
  const deleteWorkspace = useDeleteWorkspace();
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
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
    if (!canCreateMatter) {
      return;
    }
    openCreateMatter();
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
        onSuccess: () => {
          toastManager.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          });
          void (async () => {
            await queryClient.invalidateQueries({
              queryKey: workspacesKeys.all,
            });
            if (workspaceMatch?.params.workspaceId === workspaceId) {
              await navigate({ to: "/workspaces" });
            }
          })();
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

  useHotkey(HOTKEYS.TOGGLE_TIME_TRACKING, () => {
    if (currentWorkspaceId) {
      void navigate({
        to: `/workspaces/${currentWorkspaceId}/timesheets`,
      });
    }
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

  const fixedNavTargets: [
    /* 1: search */ FixedNavTarget,
    /* 2: chat */ FixedNavTarget,
    /* 3: workspaces */ FixedNavTarget,
    /* 4: knowledge */ FixedNavTarget,
    /* 5: time tracking */ FixedNavTarget,
    /* 6: contacts */ FixedNavTarget,
  ] = [
    {
      action: () => setSearchOpen(true),
      contextMenu: {
        primaryAction: {
          label: t("navigation.search"),
          icon: <SearchIcon />,
          onClick: () => setSearchOpen(true),
        },
      },
    },
    {
      action: openChat,
      contextMenu: {
        primaryAction: {
          label: t("chat.newChat"),
          icon: <PlusIcon />,
          onClick: openChat,
        },
      },
    },
    {
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
    {
      action: () => {
        void navigate({ to: "/knowledge" });
      },
      contextMenu: {
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
              onClick: () => {
                void navigate({ to: s.to });
              },
            };
          }),
      },
    },
    {
      action: () => {
        if (currentWorkspaceId) {
          void navigate({
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
              onClick: () => {
                void navigate({
                  to: "/workspaces/$workspaceId/timesheets",
                  params: { workspaceId: currentWorkspaceId },
                });
              },
            },
          }
        : {},
    },
    {
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
  ];

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
                <SidebarMenuButton asChild tooltip={t("navigation.chat")}>
                  <Link activeProps={{ "data-active": true }} to="/chat">
                    <MessageSquareIcon />
                    <span>{t("navigation.chat")}</span>
                  </Link>
                </SidebarMenuButton>
                {showNavBadges && <NavBadge digit={2} />}
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
                ) : canCreateMatter ? (
                  <SidebarMenuAction
                    onClick={handleCreateWorkspace}
                    showOnHover
                    title={t("navigation.newMatter")}
                  >
                    <PlusIcon />
                  </SidebarMenuAction>
                ) : null}
              </SidebarMenuItem>
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[3].contextMenu}>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("navigation.knowledge")}>
                  <Link activeProps={{ "data-active": true }} to="/knowledge">
                    <BookOpenIcon />
                    <span>{t("navigation.knowledge")}</span>
                  </Link>
                </SidebarMenuButton>
                {showNavBadges && <NavBadge digit={4} />}
              </SidebarMenuItem>
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[4].contextMenu}>
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
                  <NavBadge digit={5} />
                ) : currentWorkspaceId ? (
                  <SidebarTimerBadge workspaceId={currentWorkspaceId} />
                ) : null}
              </SidebarMenuItem>
            </NavContextMenu>
            <NavContextMenu config={fixedNavTargets[5].contextMenu}>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("navigation.contacts")}>
                  <Link activeProps={{ "data-active": true }} to="/contacts">
                    <UsersIcon />
                    <span>{t("navigation.contacts")}</span>
                  </Link>
                </SidebarMenuButton>
                {showNavBadges && <NavBadge digit={6} />}
              </SidebarMenuItem>
            </NavContextMenu>
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
              <SidebarGroupContent className="overflow-x-hidden overflow-y-auto">
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
          <FeedbackDialog userEmail={user.email} />
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
                <MenuItem
                  onClick={() => {
                    void navigate({
                      to: "/settings",
                    });
                  }}
                >
                  <Settings2Icon />
                  {t("settings.title")}
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
                <div className="text-muted-foreground/70 px-2 pt-1.5 pb-1 text-[0.6875rem] tabular-nums">
                  v{__APP_VERSION__}
                </div>
              </MenuPopup>
            </Menu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SearchDialog onOpenChange={setSearchOpen} open={searchOpen} />
    </Sidebar>
  );
}
