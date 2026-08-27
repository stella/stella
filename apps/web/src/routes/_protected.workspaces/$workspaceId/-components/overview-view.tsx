import type * as React from "react";
import { useCallback, useMemo, useRef, useState } from "react";

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
  PlusIcon,
  SquareCheckIcon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
} from "@stll/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { UNKNOWN_AUTHOR_LABEL } from "@stll/ui/review-author-avatar";
import { ScrollArea } from "@stll/ui/scroll-area";
import { stellaToast } from "@stll/ui/toast";
import {
  TooltipPopup,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from "@stll/ui/tooltip";
import { containedEventHandler } from "@stll/ui/use-contained-handler";
import { cn } from "@stll/ui/utils";

import { EmptyScreen } from "@/components/empty-screen";
import { isTerminalFlowRunStatus } from "@/components/flows/flow-meta";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { PersonMentionLabel } from "@/components/person-mention-label";
import { UserIdentity } from "@/components/user-avatar";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { getWeekStart, toISODate } from "@/components/workspaces/entity-utils";
import type { TaskStatus } from "@/components/workspaces/tasks/task-detail-constants";
import {
  isTaskStatus,
  STATUS_COLORS,
  STATUS_ICONS,
  TASK_STATUSES,
} from "@/components/workspaces/tasks/task-detail-constants";
import { useMountEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import { useLocale } from "@/i18n/formatting-context";
import { getFormatter, getFormattingLocale } from "@/i18n/i18n-store";
import { getFirstWeekday } from "@/i18n/week";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { getDisplayName } from "@/lib/get-display-name";
import { routeQueryOptions } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { overviewOptions, workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { flowRunsOptions } from "@/lib/workspaces/queries/flow-runs";
import { taskKeys } from "@/lib/workspaces/queries/tasks";
import {
  timeEntrySummaryOptions,
  timeEntryTeamSummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { ActivityPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/activity/activity-panel";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";

type OverviewViewProps = {
  workspaceId: string;
};

const OVERVIEW_PANEL_CLASS = "bg-background overflow-hidden rounded-lg border";
const TEAM_HEATMAP_GRID_CLASS =
  "grid grid-cols-[minmax(3.5rem,1fr)_repeat(7,1.375rem)] items-center gap-x-1 px-3 sm:grid-cols-[minmax(8rem,1fr)_repeat(7,1.75rem)_2.5rem] sm:gap-x-2 sm:px-4";

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

const getLocaleDayLabel = (
  dayIndex: number,
  locale: string,
  firstWeekday: number,
) => {
  const date = new Date(2026, 0, 4 + firstWeekday + dayIndex);
  return date.toLocaleDateString(locale, { weekday: "narrow" }).toUpperCase();
};

// Round to one decimal and render the locale's translated `hour` unit, so the
// suffix follows the active language rather than a hardcoded English "h".
const formatHours = (hours: number) =>
  getFormatter().number(Math.round(hours * 10) / 10, {
    style: "unit",
    unit: "hour",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  });

// ── Main component ───────────────────────────────────────

export const OverviewView = ({ workspaceId }: OverviewViewProps) => {
  const t = useTranslations();
  const workflowsEnabled = useWorkflowsPreviewEnabled();
  const canReadTimeEntries = usePermissions({ timeEntry: ["read"] });
  const canReviewTimeEntries = usePermissions({ timeEntry: ["approve"] });
  const timeBillingEnabled = isTimeBillingRouteEnabled() && canReadTimeEntries;
  const tWorkspaces = useTranslations("workspaces");
  const locale = useLocale();
  const firstWeekday = getFirstWeekday(locale);
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
  // The Workflows tab owns the runs fetch; this matter-overview entry point only
  // reads that cache (`enabled: false`) so the general matter shell never fires
  // GET /flows/runs for a feature most matters never open. The count reflects
  // active runs once the Workflows surface has populated the cache, and stays 0
  // (never a loading variant) until then.
  const { data: flowRunsData } = useQuery({
    ...flowRunsOptions({ workspaceId }),
    enabled: false,
  });
  const activeFlowRunCount =
    flowRunsData && "items" in flowRunsData
      ? flowRunsData.items.filter((run) => !isTerminalFlowRunStatus(run.status))
          .length
      : 0;
  const findViewByType = useCallback(
    (type: string) => views?.find((v) => v.layout.type === type),
    [views],
  );

  const handleCreateTask = useCallback(async () => {
    const { data: taskData, error: taskError } = await api
      .tasks({ workspaceId })
      .put({
        name: t("tasks.untitled"),
      });
    const entityId = taskData?.entityId;
    if (taskError || !entityId) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      return;
    }
    stellaToast.add({
      title: t("success.taskCreated"),
      type: "success",
    });
    detached(
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.overview(workspaceId),
      }),
      "overview-view.invalidate",
    );
    useInspectorTabsStore
      .getState()
      .openTask({ taskId: entityId, workspaceId, isNew: true });
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
          taskId: toSafeId<"entity">(taskId),
          status,
        });
      return unwrapEden(response);
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
      stellaToast.add({
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
  useMountEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setToday(toISODate(new Date()));
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  // Anchor the calculation to the tracked local date so visibility-driven day
  // rollover updates are explicit dependencies rather than cache invalidators.
  const weekStart = useMemo(
    () => getWeekStart(locale, new Date(`${today}T12:00:00`)),
    [today, locale],
  );
  const weekEnd = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    return end;
  }, [weekStart]);

  const { data: timeSummary } = useQuery({
    ...routeQueryOptions(
      timeEntrySummaryOptions(
        workspaceId,
        toISODate(weekStart),
        toISODate(weekEnd),
      ),
    ),
    enabled: timeBillingEnabled && !canReviewTimeEntries,
  });

  const { data: teamTimeSummary } = useQuery({
    ...routeQueryOptions(
      timeEntryTeamSummaryOptions(
        workspaceId,
        toISODate(weekStart),
        toISODate(weekEnd),
      ),
    ),
    enabled: timeBillingEnabled && canReviewTimeEntries,
  });

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

  const { data: previousTimeSummary } = useQuery({
    ...routeQueryOptions(
      timeEntrySummaryOptions(
        workspaceId,
        toISODate(prevWeekStart),
        toISODate(prevWeekEnd),
      ),
    ),
    enabled: timeBillingEnabled,
  });

  const totalHoursThisWeek =
    (teamTimeSummary
      ? teamTimeSummary.viewerTotalMinutes
      : (timeSummary?.totalMinutes ?? 0)) / 60;
  const prevWeekHours = (previousTimeSummary?.totalMinutes ?? 0) / 60;

  const teamHeatmap = useMemo(() => {
    if (!teamTimeSummary) {
      return [];
    }

    return teamTimeSummary.members.map((member) => {
      const daily = Array.from({ length: 7 }, () => 0);
      for (const entry of member.daily) {
        const parts = entry.dateWorked.split("-").map(Number);
        const year = parts[0] ?? 0;
        const month = parts[1] ?? 1;
        const day = parts[2] ?? 1;
        const entryDate = new Date(year, month - 1, day);
        const dayIdx = (entryDate.getDay() - firstWeekday + 7) % 7;
        daily[dayIdx] = (daily[dayIdx] ?? 0) + entry.totalMinutes / 60;
      }

      return {
        ...member,
        name: getDisplayName(member.name, member.email) ?? UNKNOWN_AUTHOR_LABEL,
        daily,
      };
    });
  }, [teamTimeSummary, firstWeekday]);

  const totalTeamHoursThisWeek = (teamTimeSummary?.totalTeamMinutes ?? 0) / 60;

  // Tasks with due dates, sorted by nearest deadline first
  const tasksWithDue = useMemo(
    () =>
      tasks
        .filter(
          (task) =>
            task.dueDate !== null &&
            task.status !== "done" &&
            task.status !== "cancelled",
        )
        .toSorted(
          (a, b) =>
            new Date(a.dueDate ?? 0).getTime() -
            new Date(b.dueDate ?? 0).getTime(),
        ),
    [tasks],
  );

  return (
    <div className="@container flex flex-1 flex-col gap-6 overflow-y-auto p-4 tabular-nums sm:p-6">
      {/* Stats grid */}
      <div className="grid gap-3 @sm:grid-cols-2 @3xl:grid-cols-4">
        <StatCard
          icon={<FolderTreeIcon className="size-4" />}
          label={t("workspaces.overview.totalDocuments")}
          onClick={() => {
            const view = findViewByType("filesystem");
            if (view) {
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/$viewId",
                  params: { workspaceId, viewId: view.id },
                }),
                "overview-view.navigate",
              );
            }
          }}
          value={getFormatter().number(data.documentCount)}
        />
        <StatCard
          icon={<SquareCheckIcon className="size-4" />}
          label={t("workspaces.tasksCount", { count: data.taskCount })}
          onClick={() => {
            const view = findViewByType("kanban");
            if (view) {
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/$viewId",
                  params: { workspaceId, viewId: view.id },
                }),
                "overview-view.navigate",
              );
            }
          }}
          value={getFormatter().number(data.taskCount)}
        />
        <StatCard
          icon={<CalendarClockIcon className="size-4" />}
          label={t("workspaces.overview.nextDeadline")}
          onClick={() => {
            const task = tasksWithDue.at(0);
            if (task) {
              useInspectorTabsStore.getState().openTask({
                taskId: task.entityId,
                workspaceId,
                label: task.name,
              });
            }
          }}
          sublabel={tasksWithDue.at(0)?.name}
          value={(() => {
            const date = tasksWithDue.at(0)?.dueDate;
            if (!date) {
              return "—";
            }
            return new Date(date).toLocaleDateString(getFormattingLocale(), {
              month: "short",
              day: "numeric",
            });
          })()}
        />
        {timeBillingEnabled && (
          <StatCard
            icon={<ClockIcon className="size-4" />}
            label={t("workspaces.overview.timeThisWeek")}
            onClick={() => {
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/timesheets",
                  params: { workspaceId },
                }),
                "overview-view.navigate",
              );
            }}
            value={formatHours(totalHoursThisWeek)}
          />
        )}
        {workflowsEnabled && (
          <StatCard
            icon={<WorkflowIcon className="size-4" />}
            label={t("common.workflows")}
            onClick={() => {
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/workflows",
                  params: { workspaceId },
                }),
                "overview-view.navigate",
              );
            }}
            sublabel={
              activeFlowRunCount > 0
                ? t("flows.runs.activeSublabel")
                : undefined
            }
            value={getFormatter().number(activeFlowRunCount)}
          />
        )}
      </div>

      {/* Two-column layout: tasks + team */}
      <div className="grid gap-6 @3xl:grid-cols-2">
        {/* Upcoming tasks */}
        <section
          className="flex flex-col"
          onContextMenu={containedEventHandler((e) => {
            e.preventDefault();
            e.stopPropagation();
            setUpcomingMenu({
              open: true,
              anchor: {
                getBoundingClientRect: () =>
                  new DOMRect(e.clientX, e.clientY, 0, 0),
              },
              task: null,
            });
          })}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-muted-foreground text-sm font-medium">
              {t("workspaces.overview.upcomingTasks")}
            </h2>
            <Button
              className="h-7 text-xs"
              onClick={() => {
                detached(handleCreateTask(), "overview-view.create-task");
              }}
              size="sm"
              variant="ghost"
            >
              <PlusIcon className="size-3" />
              {t("common.add")}
            </Button>
          </div>
          {(() => {
            if (tasks.length > 0) {
              return (
                <ScrollArea className="min-h-0 flex-1 rounded-lg border">
                  <div className="divide-y">
                    {tasks.map((task) => (
                      <button
                        className="hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors"
                        key={task.entityId}
                        onClick={() =>
                          useInspectorTabsStore.getState().openTask({
                            taskId: task.entityId,
                            workspaceId,
                            label: task.name,
                          })
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
                                  deletedAt: task.assignedToDeletedAt,
                                }}
                              />
                            )}
                            {task.dueDate && (
                              <>
                                {task.assignedTo ? " · " : ""}
                                {new Date(task.dueDate).toLocaleDateString(
                                  getFormattingLocale(),
                                  {
                                    month: "short",
                                    day: "numeric",
                                  },
                                )}
                              </>
                            )}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              );
            }
            return (
              <div className="text-muted-foreground flex flex-1 items-center justify-center rounded-lg border px-3 py-6 text-center text-sm">
                {t("common.noResults")}
              </div>
            );
          })()}
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
              {upcomingMenu.task === null ? (
                <MenuItem
                  onClick={() => {
                    detached(handleCreateTask(), "overview-view.create-task");
                  }}
                >
                  <EntityKindIcon kind="task" />
                  {t("tasks.newTask")}
                </MenuItem>
              ) : (
                <>
                  <MenuItem
                    onClick={() => {
                      const task = upcomingMenu.task;
                      if (task === null) {
                        return;
                      }
                      useInspectorTabsStore.getState().openTask({
                        taskId: task.entityId,
                        workspaceId,
                        label: task.name,
                      });
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
              )}
            </MenuPopup>
          </Menu>
        </section>

        {timeBillingEnabled && canReviewTimeEntries ? (
          <section className="flex min-w-0 flex-col">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-muted-foreground min-w-0 text-sm font-medium">
                <ClockIcon className="me-1.5 inline size-3.5" />
                {t("workspaces.overview.timeAndTeam")}
              </h2>
              <Button
                className="min-h-11 shrink-0 text-xs"
                onClick={() => {
                  detached(
                    navigate({
                      to: "/workspaces/$workspaceId/timesheets",
                      params: { workspaceId },
                    }),
                    "overview-view.navigate",
                  );
                }}
                size="sm"
                variant="ghost"
              >
                <PlusIcon className="size-3" />
                {t("common.logTime")}
              </Button>
            </div>
            <div className={cn(OVERVIEW_PANEL_CLASS, "flex-1")}>
              <div
                className={cn(
                  TEAM_HEATMAP_GRID_CLASS,
                  "min-h-12 border-b py-2",
                )}
              >
                <span />
                {Array.from({ length: 7 }, (_, i) => (
                  <span
                    className="text-muted-foreground text-center text-[0.625rem]"
                    key={i}
                  >
                    {getLocaleDayLabel(i, locale, firstWeekday)}
                  </span>
                ))}
                <span className="hidden sm:block" />
              </div>
              <div className="divide-y">
                {(() => {
                  const maxDaily = Math.max(
                    ...teamHeatmap.flatMap((member) => member.daily),
                    0,
                  );
                  return teamHeatmap.map((member) => {
                    const total = member.daily.reduce(
                      (sum, hours) => sum + hours,
                      0,
                    );

                    return (
                      <div
                        className={cn(
                          TEAM_HEATMAP_GRID_CLASS,
                          "min-h-14 py-2.5",
                        )}
                        key={member.userId}
                      >
                        <UserIdentity
                          avatarClassName="size-5 shrink-0 text-[0.5rem]"
                          image={member.image}
                          name={member.name}
                          nameClassName="text-sm font-normal"
                        />
                        {member.daily.map((hours, dayIdx) => {
                          const dayLabel = getLocaleDayLabel(
                            dayIdx,
                            locale,
                            firstWeekday,
                          );
                          const opacity = maxDaily > 0 ? hours / maxDaily : 0;
                          const cell = (
                            <div
                              className={cn(
                                "bg-primary/10 size-5 rounded-sm transition-transform",
                                hours > 0 && "hover:scale-110",
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
                                className="flex size-6 items-center justify-center sm:size-7"
                                // eslint-disable-next-line react/no-array-index-key -- daily is a fixed 7-slot week array.
                                key={dayIdx}
                              >
                                {cell}
                              </div>
                            );
                          }

                          return (
                            <div
                              className="flex size-6 items-center justify-center sm:size-7"
                              // eslint-disable-next-line react/no-array-index-key -- daily is a fixed 7-slot week array.
                              key={dayIdx}
                            >
                              <Popover>
                                <TooltipRoot>
                                  <PopoverTrigger
                                    render={
                                      <TooltipTrigger
                                        render={
                                          <button
                                            aria-label={`${member.name}, ${dayLabel}: ${formatHours(hours)}`}
                                            className="flex size-6 cursor-pointer items-center justify-center sm:size-7"
                                            type="button"
                                          />
                                        }
                                      />
                                    }
                                  >
                                    {cell}
                                  </PopoverTrigger>
                                  <TooltipPopup>
                                    {formatHours(hours)}
                                  </TooltipPopup>
                                </TooltipRoot>
                                <PopoverPopup className="w-56" sideOffset={8}>
                                  <p className="text-muted-foreground p-2 text-xs font-medium">
                                    {member.name} · {dayLabel} ·{" "}
                                    {formatHours(hours)}
                                  </p>
                                </PopoverPopup>
                              </Popover>
                            </div>
                          );
                        })}
                        <span className="text-muted-foreground hidden text-end text-xs tabular-nums sm:block">
                          {total > 0 ? formatHours(total) : ""}
                        </span>
                      </div>
                    );
                  });
                })()}
              </div>
              <div className="border-t px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground text-xs">
                    {t("workspaces.overview.totalThisWeek")}
                  </span>
                  <span className="text-sm font-medium tabular-nums">
                    {totalTeamHoursThisWeek > 0
                      ? formatHours(totalTeamHoursThisWeek)
                      : ""}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-muted-foreground text-xs">
                    {t("workspaces.overview.membersCount", {
                      count: teamHeatmap.length,
                    })}
                  </span>
                </div>
              </div>
            </div>
          </section>
        ) : (
          /* Personal time */
          timeBillingEnabled && (
            <section className="flex min-w-0 flex-col">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-muted-foreground min-w-0 text-sm font-medium">
                  <ClockIcon className="me-1.5 inline size-3.5" />
                  {t("workspaces.overview.timeThisWeek")}
                </h2>
                <Button
                  className="min-h-11 shrink-0 text-xs"
                  onClick={() => {
                    detached(
                      navigate({
                        to: "/workspaces/$workspaceId/timesheets",
                        params: { workspaceId },
                      }),
                      "overview-view.navigate",
                    );
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <PlusIcon className="size-3" />
                  {t("common.logTime")}
                </Button>
              </div>
              <div
                className={cn(
                  OVERVIEW_PANEL_CLASS,
                  "flex flex-1 items-center justify-between gap-3 px-4 py-6",
                )}
              >
                <div>
                  <p className="text-muted-foreground text-xs">
                    {t("workspaces.overview.totalThisWeek")}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatHours(totalHoursThisWeek)}
                  </p>
                </div>
                {prevWeekHours > 0 && totalHoursThisWeek !== prevWeekHours && (
                  <span
                    className={cn(
                      "text-xs font-medium",
                      totalHoursThisWeek > prevWeekHours
                        ? "text-success"
                        : "text-destructive",
                    )}
                  >
                    {totalHoursThisWeek > prevWeekHours ? "▲" : "▼"}{" "}
                    {Math.round(
                      Math.abs(
                        ((totalHoursThisWeek - prevWeekHours) / prevWeekHours) *
                          100,
                      ),
                    )}
                    %
                  </span>
                )}
              </div>
            </section>
          )
        )}
      </div>

      {!hasActivity && (
        <EmptyScreen
          className="min-h-[420px] overflow-visible p-0"
          description={tWorkspaces("emptyDocuments.description")}
          primaryAction={{
            label: tWorkspaces("uploadDocuments"),
            icon: UploadIcon,
            onClick: () => fileInputRef.current?.click(),
          }}
          showHelpBar={false}
          title={tWorkspaces("emptyDocuments.title")}
        />
      )}

      {hasActivity && (
        <div className="flex justify-end">
          <Button
            onClick={() => fileInputRef.current?.click()}
            size="sm"
            variant="outline"
          >
            <UploadIcon className="size-4" />
            {tWorkspaces("uploadDocuments")}
          </Button>
        </div>
      )}

      <ActivityPanel key={workspaceId} workspaceId={workspaceId} />
      <input
        className="hidden"
        multiple
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            handleCreateFileEntities({ files: [...files], parentId: null });
          }
          e.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
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
