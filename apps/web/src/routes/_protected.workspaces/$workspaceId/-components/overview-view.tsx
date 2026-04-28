import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  ClockIcon,
  FolderTreeIcon,
  LayoutDashboardIcon,
  PlusIcon,
  SquareCheckIcon,
  UploadIcon,
  UserPlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
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
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { toastManager } from "@stella/ui/components/toast";
import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stella/ui/components/tooltip";
import { cn } from "@stella/ui/lib/utils";

import { renderDragPreview } from "@/components/drag-preview";
import { PersonMentionLabel } from "@/components/person-mention-label";
import { useI18nStore } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { isFileDisplayable } from "@/lib/types";
import type { EntityKind, WorkspaceEntity } from "@/lib/types";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import type { TaskStatus } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import {
  isTaskStatus,
  STATUS_COLORS,
  STATUS_ICONS,
  TASK_STATUSES,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { taskKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/tasks";
import { timeEntriesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workspaceMembersOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import {
  getWeekStart,
  toISODate,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";
import {
  overviewOptions,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries";

type OverviewViewProps = {
  workspaceId: string;
};

type UpcomingTaskContext = {
  entityId: string;
  name: string;
  status: string | null;
};

type VirtualAnchor = {
  getBoundingClientRect: () => DOMRect;
};

type UpcomingMenuState = {
  open: boolean;
  anchor: VirtualAnchor | null;
  task: UpcomingTaskContext | null;
};

// ── Helpers ───────────────────────────────────────────────

/**
 * Get the single-letter day abbreviation for a given
 * weekday index (0 = Monday) in the user's locale.
 */
const getLocaleDayLabel = (dayIndex: number, locale: string) => {
  // Jan 5, 2026 is a Monday
  const date = new Date(2026, 0, 5 + dayIndex);
  return date.toLocaleDateString(locale, { weekday: "narrow" }).toUpperCase();
};

// ── Main component ───────────────────────────────────────

export const OverviewView = ({ workspaceId }: OverviewViewProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(overviewOptions(workspaceId));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [upcomingMenu, setUpcomingMenu] = useState<UpcomingMenuState>({
    open: false,
    anchor: null,
    task: null,
  });
  const [, handleCreateFileEntities] = useCreateFileEntities(workspaceId);
  // Views — find view IDs by layout type for stat card navigation
  const { data: views } = useQuery(viewsOptions(workspaceId));
  const findViewByType = useCallback(
    (type: string) => views?.find((v) => v.layout.type === type),
    [views],
  );

  const handleCreateTask = useCallback(async () => {
    const response = await api.tasks({ workspaceId }).put({
      queryKey: entitiesKeys.all(workspaceId),
      name: t("tasks.untitled"),
    });
    const entityId = response.data?.entityId;
    if (response.error || !entityId) {
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }
    toastManager.add({
      title: t("success.taskCreated"),
      type: "success",
    });
    // eslint-disable-next-line typescript/no-floating-promises
    queryClient.invalidateQueries({
      queryKey: workspacesKeys.overview(workspaceId),
    });
    useInspectorStore.getState().openTask(entityId, "", true);
  }, [workspaceId, t, queryClient]);

  const updateTaskStatus = useMutation({
    mutationFn: async ({
      taskId,
      status,
    }: {
      taskId: string;
      status: TaskStatus;
    }) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          queryKey: entitiesKeys.all(workspaceId),
          taskId: toSafeId<"entity">(taskId),
          status,
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: taskKeys.detail(workspaceId, variables.taskId),
        }),
        queryClient.invalidateQueries({
          queryKey: workspacesKeys.overview(workspaceId),
        }),
      ]);
    },
    onError: () => {
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  const handleTaskContextMenu = useCallback(
    (task: UpcomingTaskContext) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setUpcomingMenu({
        open: true,
        anchor: {
          getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0),
        },
        task,
      });
    },
    [],
  );

  const menuTaskStatus = upcomingMenu.task?.status ?? null;
  const currentMenuTaskStatus = isTaskStatus(menuTaskStatus)
    ? menuTaskStatus
    : "open";
  const taskStatusLabels: Record<TaskStatus, string> = {
    open: t("tasks.statusValues.open"),
    in_progress: t("tasks.statusValues.in_progress"),
    in_review: t("tasks.statusValues.in_review"),
    done: t("tasks.statusValues.done"),
    cancelled: t("tasks.statusValues.cancelled"),
  };

  const recentEntities = useMemo(
    () => data.recentEntities.filter((e) => e.kind !== "folder"),
    [data.recentEntities],
  );
  const hasActivity = recentEntities.length > 0;

  // Tasks from recent entities (kind === "task")
  const tasks = useMemo(
    () => data.recentEntities.filter((e) => e.kind === "task"),
    [data.recentEntities],
  );

  // Re-compute the current date when the user returns to the
  // tab so the heatmap refreshes across day/week boundaries.
  const [today, setToday] = useState(() => toISODate(new Date()));
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setToday(toISODate(new Date()));
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const weekStart = useMemo(getWeekStart, [today]);
  const weekEnd = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    return end;
  }, [weekStart]);

  const { data: timeEntries } = useQuery(
    timeEntriesOptions(workspaceId, {
      dateFrom: toISODate(weekStart),
      dateTo: toISODate(weekEnd),
    }),
  );

  // Previous week for trend comparison
  const prevWeekStart = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() - 7);
    return d;
  }, [weekStart]);
  const prevWeekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() - 1);
    return d;
  }, [weekStart]);

  const { data: prevTimeEntries } = useQuery(
    timeEntriesOptions(workspaceId, {
      dateFrom: toISODate(prevWeekStart),
      dateTo: toISODate(prevWeekEnd),
    }),
  );

  const prevWeekHours = useMemo(
    () =>
      prevTimeEntries
        ? prevTimeEntries.reduce((sum, e) => sum + e.durationMinutes / 60, 0)
        : null,
    [prevTimeEntries],
  );

  const { data: members } = useQuery(workspaceMembersOptions(workspaceId));

  // Build per-user daily heatmap from real time entries
  const teamHeatmap = useMemo(() => {
    if (!members || !timeEntries) {
      return [];
    }

    return members
      .filter(
        (
          member,
        ): member is typeof member & {
          user: NonNullable<typeof member.user>;
        } => member.user !== null,
      )
      .map((member) => {
        const daily = Array.from({ length: 7 }, () => 0);
        const dailyEntries: Record<
          number,
          { description: string; hours: number }[]
        > = {};

        for (const entry of timeEntries) {
          if (entry.userId !== member.userId) {
            continue;
          }
          // Parse YYYY-MM-DD as local date (not UTC) to avoid
          // timezone-shifted day attribution for UTC- users.
          const parts = entry.dateWorked.split("-").map(Number);
          const y = parts[0] ?? 0;
          const m = parts[1] ?? 1;
          const d = parts[2] ?? 1;
          const entryDate = new Date(y, m - 1, d);
          const dayOfWeek = entryDate.getDay();
          // Convert Sunday=0 to index 6, Monday=1 to 0
          const dayIdx = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
          const hours = entry.durationMinutes / 60;
          daily[dayIdx] = (daily[dayIdx] ?? 0) + hours;

          const entries = dailyEntries[dayIdx] ?? [];
          entries.push({
            description: entry.narrative || entry.taskCode || "—",
            hours,
          });
          dailyEntries[dayIdx] = entries;
        }

        return {
          userId: member.userId,
          name: member.user.name ?? member.user.email ?? "—",
          image: member.user.image,
          daily,
          dailyEntries,
        };
      });
  }, [members, timeEntries]);

  const totalHoursThisWeek = useMemo(
    () =>
      teamHeatmap.reduce(
        (sum, m) => sum + m.daily.reduce((s, h) => s + h, 0),
        0,
      ),
    [teamHeatmap],
  );

  // Tasks with due dates, sorted by nearest deadline first
  const tasksWithDue = useMemo(
    () =>
      tasks
        .filter((task) => task.dueDate !== null && task.status !== "closed")
        .toSorted(
          (a, b) =>
            new Date(a.dueDate ?? 0).getTime() -
            new Date(b.dueDate ?? 0).getTime(),
        ),
    [tasks],
  );

  return (
    <div className="@container flex flex-1 flex-col gap-6 overflow-y-auto p-6 tabular-nums">
      {/* Stats grid */}
      <div className="grid gap-3 @sm:grid-cols-2 @3xl:grid-cols-4">
        <StatCard
          icon={<FolderTreeIcon className="size-4" />}
          label={t("workspaces.overview.totalDocuments")}
          onClick={() => {
            const view = findViewByType("filesystem");
            if (view) {
              // eslint-disable-next-line typescript/no-floating-promises
              navigate({
                to: "/workspaces/$workspaceId/$viewId",
                params: { workspaceId, viewId: view.id },
              });
            }
          }}
          value={String(data.documentCount)}
        />
        <StatCard
          icon={<SquareCheckIcon className="size-4" />}
          label={t("workspaces.tasksCount", { count: data.taskCount })}
          onClick={() => {
            const view = findViewByType("kanban");
            if (view) {
              // eslint-disable-next-line typescript/no-floating-promises
              navigate({
                to: "/workspaces/$workspaceId/$viewId",
                params: { workspaceId, viewId: view.id },
              });
            }
          }}
          value={`${data.taskCount}`}
        />
        <StatCard
          icon={<CalendarClockIcon className="size-4" />}
          label={t("workspaces.overview.nextDeadline")}
          onClick={() => {
            const task = tasksWithDue.at(0);
            if (task) {
              useInspectorStore.getState().openTask(task.entityId, task.name);
            }
          }}
          sublabel={tasksWithDue.at(0)?.name}
          value={(() => {
            const date = tasksWithDue.at(0)?.dueDate;
            if (!date) {
              return "—";
            }
            return new Date(date).toLocaleDateString(lang, {
              month: "short",
              day: "numeric",
            });
          })()}
        />
        <StatCard
          icon={<ClockIcon className="size-4" />}
          label={t("workspaces.overview.timeThisWeek")}
          onClick={() => {
            // eslint-disable-next-line typescript/no-floating-promises
            navigate({
              to: "/workspaces/$workspaceId/timesheets",
              params: { workspaceId },
            });
          }}
          value={`${Math.round(totalHoursThisWeek * 10) / 10}h`}
        />
      </div>

      {/* Two-column layout: tasks + team */}
      <div className="grid gap-6 @3xl:grid-cols-2">
        {/* Upcoming tasks */}
        <section className="flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t("workspaces.overview.upcomingTasks")}
            </h2>
            <Button
              className="h-7 text-xs"
              // eslint-disable-next-line typescript/no-misused-promises
              onClick={handleCreateTask}
              size="sm"
              variant="ghost"
            >
              <PlusIcon className="size-3" />
              {t("common.add")}
            </Button>
          </div>
          {tasks.length > 0 ? (
            <ScrollArea className="min-h-0 flex-1 rounded-lg border">
              <div className="divide-y">
                {tasks.map((task) => (
                  <button
                    className="hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors"
                    key={task.entityId}
                    onClick={() =>
                      useInspectorStore
                        .getState()
                        .openTask(task.entityId, task.name)
                    }
                    onContextMenu={handleTaskContextMenu({
                      entityId: task.entityId,
                      name: task.name,
                      status: task.status,
                    })}
                    type="button"
                  >
                    <EntityKindIcon
                      className="size-4 shrink-0"
                      kind="task"
                      status={task.status}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "truncate text-sm",
                          (task.status === "done" ||
                            task.status === "cancelled") &&
                            "text-muted-foreground line-through",
                        )}
                      >
                        {task.name}
                      </p>
                      <span className="text-muted-foreground flex items-center gap-1 text-xs">
                        {task.assignedTo !== null && (
                          <PersonMentionLabel
                            avatarClassName="size-4 text-[7px]"
                            mention={{
                              name: task.assignedTo,
                              image: task.assignedToImage,
                            }}
                          />
                        )}
                        {task.dueDate && (
                          <>
                            {task.assignedTo ? " · " : ""}
                            {new Date(task.dueDate).toLocaleDateString(lang, {
                              month: "short",
                              day: "numeric",
                            })}
                          </>
                        )}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="text-muted-foreground flex flex-1 items-center justify-center rounded-lg border px-3 py-6 text-center text-sm">
              {t("common.noResults")}
            </div>
          )}
          <Menu
            onOpenChange={(open) => {
              setUpcomingMenu((previous) =>
                open
                  ? { ...previous, open }
                  : { open: false, anchor: null, task: null },
              );
            }}
            open={upcomingMenu.open}
          >
            <MenuTrigger
              nativeButton={false}
              render={<span className="sr-only" />}
            />
            <MenuPopup anchor={upcomingMenu.anchor ?? undefined}>
              {upcomingMenu.task !== null ? (
                <>
                  <MenuItem
                    onClick={() => {
                      const task = upcomingMenu.task;
                      if (task === null) {
                        return;
                      }
                      useInspectorStore
                        .getState()
                        .openTask(task.entityId, task.name);
                    }}
                  >
                    <SquareCheckIcon />
                    {upcomingMenu.task.name}
                  </MenuItem>
                  <MenuSub>
                    <MenuSubTrigger>
                      {(() => {
                        const Icon = STATUS_ICONS[currentMenuTaskStatus];
                        return (
                          <>
                            <Icon
                              className={cn(
                                "size-4",
                                STATUS_COLORS[currentMenuTaskStatus],
                              )}
                            />
                            {t("common.status")}
                          </>
                        );
                      })()}
                    </MenuSubTrigger>
                    <MenuSubPopup>
                      <MenuRadioGroup value={currentMenuTaskStatus}>
                        {TASK_STATUSES.map((status) => {
                          const Icon = STATUS_ICONS[status];
                          return (
                            <MenuRadioItem
                              key={status}
                              onClick={() => {
                                if (status === currentMenuTaskStatus) {
                                  return;
                                }
                                const task = upcomingMenu.task;
                                if (task === null) {
                                  return;
                                }
                                updateTaskStatus.mutate({
                                  taskId: task.entityId,
                                  status,
                                });
                              }}
                              value={status}
                            >
                              <span className="flex items-center gap-2">
                                <Icon
                                  className={cn(
                                    "size-4",
                                    STATUS_COLORS[status],
                                  )}
                                />
                                {taskStatusLabels[status]}
                              </span>
                            </MenuRadioItem>
                          );
                        })}
                      </MenuRadioGroup>
                    </MenuSubPopup>
                  </MenuSub>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </section>

        {/* Time & Team */}
        <section className="flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-muted-foreground text-sm font-medium">
              <ClockIcon className="me-1.5 inline size-3.5" />
              {t("workspaces.overview.timeAndTeam")}
            </h2>
            <Button
              className="h-7 text-xs"
              onClick={() => {
                // eslint-disable-next-line typescript/no-floating-promises
                navigate({
                  to: "/workspaces/$workspaceId/timesheets",
                  params: { workspaceId },
                });
              }}
              size="sm"
              variant="ghost"
            >
              <PlusIcon className="size-3" />
              {t("common.logTime")}
            </Button>
          </div>
          <div className="flex-1 rounded-lg border">
            {/* Day labels — i18n via Intl.DateTimeFormat */}
            <div className="flex items-center gap-3 border-b px-3 py-1.5">
              <span className="w-20 shrink-0 @lg:w-28" />
              <div className="flex flex-1 justify-between">
                {Array.from({ length: 7 }, (_, i) => (
                  <span
                    className="text-muted-foreground w-7 text-center text-[0.625rem]"
                    // eslint-disable-next-line react/no-array-index-key
                    key={i}
                  >
                    {getLocaleDayLabel(i, lang)}
                  </span>
                ))}
              </div>
              <span className="w-10 shrink-0" />
            </div>
            <div className="divide-y">
              {(() => {
                const maxDaily = Math.max(
                  ...teamHeatmap.flatMap((m) => m.daily),
                  0,
                );
                return teamHeatmap.map((member) => {
                  const total =
                    Math.round(
                      member.daily.reduce((sum, h) => sum + h, 0) * 10,
                    ) / 10;

                  return (
                    <div
                      className="flex items-center gap-3 px-3 py-2"
                      key={member.userId}
                    >
                      <div className="flex w-20 shrink-0 items-center gap-2 @lg:w-28">
                        <Avatar className="size-5 text-[0.5rem]">
                          {member.image && <AvatarImage src={member.image} />}
                          <AvatarFallback>
                            {member.name
                              .split(" ")
                              .map((w) => w.at(0))
                              .join("")
                              .toUpperCase()
                              .slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate text-xs">{member.name}</span>
                      </div>
                      <div className="flex flex-1 justify-between">
                        {member.daily.map((hours, dayIdx) => {
                          const opacity = maxDaily > 0 ? hours / maxDaily : 0;
                          const entries = member.dailyEntries[dayIdx] ?? [];

                          const cell = (
                            <div
                              className={cn(
                                "bg-primary/10 size-5 rounded-sm transition-transform",
                                hours > 0 && "cursor-pointer hover:scale-110",
                              )}
                              style={
                                hours > 0
                                  ? {
                                      backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(opacity * 80 + 10)}%, transparent)`,
                                    }
                                  : undefined
                              }
                            />
                          );

                          if (hours === 0) {
                            return (
                              <div
                                className="flex w-7 justify-center"
                                // eslint-disable-next-line react/no-array-index-key
                                key={dayIdx}
                              >
                                {cell}
                              </div>
                            );
                          }

                          return (
                            <div
                              className="flex w-7 justify-center"
                              // eslint-disable-next-line react/no-array-index-key
                              key={dayIdx}
                            >
                              <Popover>
                                <TooltipRoot>
                                  <PopoverTrigger
                                    render={
                                      <TooltipTrigger
                                        render={
                                          <button
                                            className="cursor-pointer"
                                            type="button"
                                          />
                                        }
                                      />
                                    }
                                  >
                                    {cell}
                                  </PopoverTrigger>
                                  <TooltipPopup>
                                    {Math.round(hours * 10) / 10}h
                                  </TooltipPopup>
                                </TooltipRoot>
                                <PopoverPopup className="w-56" sideOffset={8}>
                                  <div className="p-2">
                                    <p className="text-muted-foreground mb-2 text-xs font-medium">
                                      {member.name} ·{" "}
                                      {getLocaleDayLabel(dayIdx, lang)}
                                      {" · "}
                                      {Math.round(hours * 10) / 10}h
                                    </p>
                                    {entries.length > 0 ? (
                                      <div className="space-y-1.5">
                                        {entries.map((entry) => (
                                          <div
                                            className="flex items-start justify-between gap-2"
                                            key={entry.description}
                                          >
                                            <span className="text-xs">
                                              {entry.description}
                                            </span>
                                            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                                              {Math.round(entry.hours * 10) /
                                                10}
                                              h
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <p className="text-muted-foreground text-xs">
                                        {t("common.noResults")}
                                      </p>
                                    )}
                                  </div>
                                </PopoverPopup>
                              </Popover>
                            </div>
                          );
                        })}
                      </div>
                      <span className="text-muted-foreground w-10 shrink-0 text-end text-xs tabular-nums">
                        {total > 0 ? `${total}h` : ""}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
            <div className="border-t px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">
                  {t("workspaces.overview.totalThisWeek")}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">
                    {totalHoursThisWeek > 0
                      ? `${Math.round(totalHoursThisWeek * 10) / 10}h`
                      : ""}
                  </span>
                  {prevWeekHours !== null &&
                    prevWeekHours > 0 &&
                    totalHoursThisWeek !== prevWeekHours && (
                      <span
                        className={cn(
                          "text-xs font-medium",
                          totalHoursThisWeek > prevWeekHours
                            ? "text-green-600"
                            : "text-red-500",
                        )}
                      >
                        {totalHoursThisWeek > prevWeekHours ? "▲" : "▼"}{" "}
                        {Math.round(
                          Math.abs(
                            ((totalHoursThisWeek - prevWeekHours) /
                              prevWeekHours) *
                              100,
                          ),
                        )}
                        %
                      </span>
                    )}
                </div>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-muted-foreground text-xs">
                  {t("workspaces.overview.membersCount", {
                    count: teamHeatmap.length,
                  })}
                </span>
                <Button
                  className="h-auto p-0 text-xs"
                  onClick={() => {
                    // eslint-disable-next-line typescript/no-floating-promises
                    navigate({ to: "/organization/members" });
                  }}
                  size="sm"
                  variant="link"
                >
                  <UserPlusIcon className="size-3" />
                  {t("workspaces.members.addMember")}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Recent activity */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-muted-foreground text-sm font-medium">
            {t("workspaces.overview.recentActivity")}
          </h2>
          <Button
            className="h-7 text-xs"
            onClick={() => fileInputRef.current?.click()}
            size="sm"
            variant="ghost"
          >
            <UploadIcon className="size-3" />
            {t("common.uploadFiles")}
          </Button>
          <input
            className="hidden"
            multiple
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) {
                handleCreateFileEntities([...files]);
              }
              e.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />
        </div>
        {hasActivity ? (
          <div className="divide-y rounded-lg border">
            {recentEntities.map((entity) => (
              <OverviewRow
                entity={entity}
                key={entity.entityId}
                lang={lang}
                workspaceId={workspaceId}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={LayoutDashboardIcon}
            message={t("workspaces.overview.getStarted")}
            workspaceId={workspaceId}
          />
        )}
      </section>
    </div>
  );
};

type StatCardProps = {
  icon: React.ReactNode;
  label: string;
  value: string;
  sublabel?: string | undefined;
  onClick?: () => void;
};

const StatCard = ({ icon, label, value, sublabel, onClick }: StatCardProps) => {
  const content = (
    <>
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {icon}
        {label}
      </div>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      {sublabel && (
        <span className="text-muted-foreground truncate text-xs">
          {sublabel}
        </span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        className="bg-card hover:bg-muted/50 flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-start transition-colors"
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="bg-card flex flex-col gap-1.5 rounded-lg border px-4 py-3">
      {content}
    </div>
  );
};

// -- Overview entity row with context menu + actions --

type OverviewEntity = {
  entityId: string;
  name: string;
  kind: EntityKind;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  mimeType: string | null;
  fieldId: string | null;
  propertyId: string | null;
  pdfFileId: string | null;
  encrypted: boolean;
  createdAt: string;
  createdBy: string | null;
  createdByImage: string | null;
  assignedTo: string | null;
  assignedToImage: string | null;
  updatedAt: string | null;
};

type OverviewRowProps = {
  entity: OverviewEntity;
  workspaceId: string;
  lang: string;
};

const OverviewRow = ({ entity, workspaceId, lang }: OverviewRowProps) => {
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<VirtualAnchor | null>(
    null,
  );
  const rowRef = useRef<HTMLDivElement>(null);

  useInspectorFlash(entity.entityId, rowRef);

  // Construct a WorkspaceEntity from overview data so RowActions
  // can render. The overview endpoint returns enough metadata to
  // build a synthetic fields record for the primary file.
  // Previously TODO by @nnad3N — now resolved.
  const fullEntity = useMemo((): WorkspaceEntity => {
    const fields: WorkspaceEntity["fields"] = {};
    const propertyKey = entity.propertyId ?? entity.fieldId;
    const fieldKey = entity.fieldId ?? propertyKey;
    if (propertyKey && fieldKey && entity.mimeType) {
      fields[propertyKey] = {
        id: fieldKey,
        entityId: entity.entityId,
        content: {
          type: "file",
          version: 1,
          id: fieldKey,
          fileName: entity.name,
          mimeType: entity.mimeType,
          sizeBytes: 0,
          encrypted: entity.encrypted,
          sha256Hex: "",
          pdfFileId: entity.pdfFileId,
        },
      };
    }
    return {
      entityId: entity.entityId,
      kind: entity.kind,
      name: entity.name,
      parentId: null,
      createdAt: entity.createdAt,
      createdBy: entity.createdBy,
      createdByImage: entity.createdByImage,
      updatedAt: entity.updatedAt,
      version: 0,
      status: entity.status,
      priority: entity.priority,
      dueDate: entity.dueDate,
      sortOrder: null,
      activeEditBy: null,
      fields,
    };
  }, [entity]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
    setContextOpen(true);
  }, []);

  const navigable =
    entity.mimeType !== null &&
    entity.fieldId !== null &&
    isFileDisplayable({
      mimeType: entity.mimeType,
      pdfFileId: entity.pdfFileId,
      encrypted: entity.encrypted,
    });

  const icon = (
    <EntityKindIcon
      className="size-4 shrink-0"
      kind={entity.kind}
      mimeType={entity.mimeType}
      status={entity.status}
    />
  );

  useEffect(() => {
    const el = rowRef.current;
    if (!el) {
      return undefined;
    }
    return draggable({
      element: el,
      getInitialData: () => ({
        type: ENTITY_DRAG_TYPE,
        entityId: entity.entityId,
        name: entity.name,
        kind: entity.kind,
        mimeType: entity.mimeType,
        entityIds: [entity.entityId],
        entities: [
          {
            entityId: entity.entityId,
            name: entity.name,
            kind: entity.kind,
            mimeType: entity.mimeType,
            parentId: null,
          },
        ],
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          render: ({ container }) =>
            renderDragPreview(container, {
              name: entity.name,
              kind: entity.kind,
              mimeType: entity.mimeType,
            }),
        });
      },
    });
  }, [entity.entityId, entity.name, entity.kind, entity.mimeType]);

  const { fieldId } = entity;

  const handleOpen =
    entity.kind === "task"
      ? () =>
          useInspectorStore.getState().openTask(entity.entityId, entity.name)
      : navigable && fieldId
        ? () =>
            useInspectorStore.getState().openPdf({
              id: fieldId,
              entityId: entity.entityId,
              label: entity.name,
              mimeType: entity.mimeType ?? undefined,
              pdfFileId: entity.pdfFileId,
              propertyId: entity.propertyId ?? undefined,
              workspaceId,
            })
        : undefined;

  const t = useTranslations();
  const relTime = formatRelativeTime(
    entity.updatedAt ?? entity.createdAt,
    lang,
  );

  /** Entities whose updatedAt is within this window of createdAt
   *  are considered "just uploaded" rather than "edited". */
  const UPLOAD_THRESHOLD_MS = 5000;

  const isNewUpload =
    entity.mimeType !== null &&
    (!entity.updatedAt ||
      Math.abs(
        new Date(entity.createdAt).getTime() -
          new Date(entity.updatedAt).getTime(),
      ) < UPLOAD_THRESHOLD_MS);

  const activityLabel = isNewUpload
    ? t("workspaces.overview.uploaded")
    : t("workspaces.overview.edited");

  const content = (
    <>
      {entity.createdBy !== null && (
        <PersonMentionLabel
          avatarClassName="size-5 text-[8px]"
          className="w-36 shrink-0 truncate"
          mention={{
            name: entity.createdBy,
            image: entity.createdByImage,
          }}
        />
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-sm">
        <span className="text-muted-foreground shrink-0">{activityLabel}</span>{" "}
        {icon}
        <span className="truncate">{entity.name}</span>
      </span>
      {relTime && (
        <span
          className="text-muted-foreground shrink-0 text-xs tabular-nums"
          title={formatFullTimestamp(
            entity.updatedAt ?? entity.createdAt,
            lang,
          )}
        >
          {relTime}
        </span>
      )}
      {/* TODO: fix this */}
      {/* oxlint-disable-next-line jsx_a11y/click-events-have-key-events, jsx_a11y/no-static-element-interactions */}
      <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <RowActions
          anchor={contextAnchor}
          entity={fullEntity}
          onOpen={handleOpen}
          onOpenChange={(o) => {
            setContextOpen(o);
            if (!o) {
              setContextAnchor(null);
            }
          }}
          open={contextOpen}
          workspaceId={workspaceId}
        />
      </span>
    </>
  );

  const handleKeyDown = handleOpen
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleOpen();
        }
      }
    : undefined;

  return (
    // Use a <div> instead of <button> to avoid invalid
    // nested <button> elements (RowActions renders a
    // <button> menu trigger inside).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={cn(
        "group/row hover:bg-muted/50 flex items-center gap-3 px-4 py-2.5",
        handleOpen && "w-full cursor-pointer text-start",
      )}
      onClick={handleOpen}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      ref={rowRef}
      role={handleOpen ? "button" : undefined}
      tabIndex={handleOpen ? 0 : undefined}
    >
      {content}
    </div>
  );
};
