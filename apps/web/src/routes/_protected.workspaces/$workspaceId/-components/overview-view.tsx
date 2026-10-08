import type * as React from "react";
import { useCallback, useMemo, useState } from "react";

import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { compareCodeUnit } from "@stll/collation";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { openFilePicker } from "@stll/ui/file-picker";
import {
  CalendarClockIcon,
  ClockIcon,
  FolderTreeIcon,
  PlusIcon,
  SquareCheckIcon,
  UploadIcon,
  WorkflowIcon,
} from "@stll/ui/icons";
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
import { QueryViewFeedback } from "@/components/query-view-feedback";
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
import { useTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import { useLocale } from "@/i18n/formatting-context";
import { getFormatter } from "@/i18n/i18n-store";
import { getFirstWeekday } from "@/i18n/week";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { getDisplayName } from "@/lib/get-display-name";
import { routeQueryOptions } from "@/lib/react-query";
import {
  DAY_AND_MONTH_FORMAT,
  WEEKDAY_INITIAL_FORMAT,
} from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView } from "@/lib/use-query-view";
import { useCreateFileEntities } from "@/lib/workspaces/mutations/use-create-file-entities";
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

import { OverviewTimeRead, OverviewTimeTrend } from "./overview-time-read";

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

const getLocaleDayLabel = (dayIndex: number, firstWeekday: number) => {
  const date = Temporal.PlainDate.from("2026-01-04").add({
    days: firstWeekday + dayIndex,
  });
  return getFormatter()
    .dateTime(
      date.toZonedDateTime({
        plainTime: Temporal.PlainTime.from("00:00"),
        timeZone: "UTC",
      }).epochMilliseconds,
      { ...WEEKDAY_INITIAL_FORMAT, timeZone: "UTC" },
    )
    .toUpperCase();
};

const toDateTimeEpoch = (value: string): number => {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return Temporal.PlainDate.from(value).toZonedDateTime({
      plainTime: Temporal.PlainTime.from("00:00"),
      timeZone: "UTC",
    }).epochMilliseconds;
  }
  return Temporal.Instant.from(value).epochMilliseconds;
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
  const timeBillingEnabled = useTimeBillingRouteEnabled() && canReadTimeEntries;
  const tWorkspaces = useTranslations("workspaces");
  const locale = useLocale();
  const firstWeekday = getFirstWeekday(locale);
  const navigate = useNavigate({ from: "/workspaces/$workspaceId" });
  const queryClient = useQueryClient();
  const userId = useAuthenticatedUser().id;
  const { data } = useSuspenseQuery(overviewOptions(workspaceId));
  const [upcomingMenu, setUpcomingMenu] = useState<UpcomingMenuState>({
    open: false,
    anchor: null,
    task: null,
  });
  const [, handleCreateFileEntities] = useCreateFileEntities(workspaceId);
  const openUploadPicker = () =>
    openFilePicker({
      multiple: true,
      onPick: (files) => {
        handleCreateFileEntities({ files, parentId: null });
      },
    });
  // Views — find view IDs by layout type for stat card navigation
  const viewsQuery = useQuery(viewsOptions(workspaceId));
  const viewsView = useQueryView(viewsQuery);
  const views = viewsView.type === "items" ? viewsView.items : undefined;
  // The Workflows tab owns the runs fetch; this matter-overview entry point only
  // reads that cache (`enabled: false`) so the general matter shell never fires
  // GET /flows/runs for a feature most matters never open. The count reflects
  // active runs once the Workflows surface has populated the cache, and stays 0
  // (never a loading variant) until then.
  const flowRunsDataQuery = useQuery({
    ...flowRunsOptions({ workspaceId }),
    enabled: false,
  });
  const flowRunsDataView = useQueryView(flowRunsDataQuery);
  const flowRunsData =
    flowRunsDataView.type === "items" ? flowRunsDataView.items : undefined;
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
      notifyUserError(
        taskError ? toAPIError(taskError) : undefined,
        t("errors.actionFailed"),
      );
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
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
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
  const [today, setToday] = useState(() =>
    Temporal.Now.instant()
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toPlainDate()
      .toString(),
  );
  useMountEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setToday(
          Temporal.Now.instant()
            .toZonedDateTimeISO(Temporal.Now.timeZoneId())
            .toPlainDate()
            .toString(),
        );
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  // Anchor the calculation to the tracked local date so visibility-driven day
  // rollover updates are explicit dependencies rather than cache invalidators.
  const weekStart = useMemo(
    () => getWeekStart(locale, Temporal.PlainDate.from(today)),
    [today, locale],
  );
  const weekEnd = useMemo(() => weekStart.add({ days: 6 }), [weekStart]);

  const timeSummaryView = useQueryView(
    useQuery({
      ...routeQueryOptions(
        timeEntrySummaryOptions(
          workspaceId,
          userId,
          toISODate(weekStart),
          toISODate(weekEnd),
        ),
      ),
      enabled: timeBillingEnabled && !canReviewTimeEntries,
    }),
  );

  const teamTimeSummaryView = useQueryView(
    useQuery({
      ...routeQueryOptions(
        timeEntryTeamSummaryOptions(
          workspaceId,
          userId,
          toISODate(weekStart),
          toISODate(weekEnd),
        ),
      ),
      enabled: timeBillingEnabled && canReviewTimeEntries,
    }),
  );

  // Previous week for trend comparison
  const prevWeekStart = useMemo(
    () => weekStart.subtract({ days: 7 }),
    [weekStart],
  );
  const prevWeekEnd = useMemo(
    () => weekStart.subtract({ days: 1 }),
    [weekStart],
  );

  const previousTimeSummaryView = useQueryView(
    useQuery({
      ...routeQueryOptions(
        timeEntrySummaryOptions(
          workspaceId,
          userId,
          toISODate(prevWeekStart),
          toISODate(prevWeekEnd),
        ),
      ),
      enabled: timeBillingEnabled,
    }),
  );

  const currentTimeView = canReviewTimeEntries
    ? teamTimeSummaryView
    : timeSummaryView;
  const teamTimeSummary =
    teamTimeSummaryView.type === "items"
      ? teamTimeSummaryView.items
      : undefined;
  const totalHoursThisWeek =
    currentTimeView.type === "items"
      ? ("viewerTotalMinutes" in currentTimeView.items
          ? currentTimeView.items.viewerTotalMinutes
          : currentTimeView.items.totalMinutes) / 60
      : null;

  const teamHeatmap = useMemo(() => {
    if (!teamTimeSummary) {
      return [];
    }

    return teamTimeSummary.members.map((member) => {
      const daily = Array.from({ length: 7 }, () => 0);
      for (const entry of member.daily) {
        const entryDate = Temporal.PlainDate.from(entry.dateWorked);
        const dayIdx = ((entryDate.dayOfWeek % 7) - firstWeekday + 7) % 7;
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
        .toSorted((a, b) => compareCodeUnit(a.dueDate ?? "", b.dueDate ?? "")),
    [tasks],
  );

  return (
    <div className="@container flex flex-1 flex-col gap-6 overflow-y-auto p-4 tabular-nums sm:p-6">
      <OverviewQueryFeedback
        flowRunsView={flowRunsDataView}
        viewsView={viewsView}
      />
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
            return getFormatter().dateTime(toDateTimeEpoch(date), {
              ...DAY_AND_MONTH_FORMAT,
              timeZone: "UTC",
            });
          })()}
        />
        {timeBillingEnabled && (
          <StatCard
            icon={<ClockIcon className="size-4" />}
            label={t("workspaces.overview.timeThisWeek")}
            {...(currentTimeView.type === "items" &&
            currentTimeView.refetchError === undefined
              ? {
                  onClick: () => {
                    detached(
                      navigate({
                        to: "/workspaces/$workspaceId/timesheets",
                        params: { workspaceId },
                      }),
                      "overview-view.navigate",
                    );
                  },
                }
              : {})}
            value={
              canReviewTimeEntries ? (
                <OverviewTimeRead view={teamTimeSummaryView}>
                  {(summary) => formatHours(summary.viewerTotalMinutes / 60)}
                </OverviewTimeRead>
              ) : (
                <OverviewTimeRead view={timeSummaryView}>
                  {(summary) => formatHours(summary.totalMinutes / 60)}
                </OverviewTimeRead>
              )
            }
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
          <OverviewSectionHeader
            actionLabel={t("common.add")}
            icon={<SquareCheckIcon />}
            onAction={() => {
              detached(handleCreateTask(), "overview-view.create-task");
            }}
            title={t("workspaces.overview.upcomingTasks")}
          />
          {(() => {
            if (tasks.length > 0) {
              return (
                <ScrollArea className="min-h-0 flex-1 rounded-lg border">
                  <div className="divide-y">
                    {tasks.map((task) => (
                      <button
                        className="hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2.5 text-start"
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
                                {getFormatter().dateTime(
                                  toDateTimeEpoch(task.dueDate),
                                  { ...DAY_AND_MONTH_FORMAT, timeZone: "UTC" },
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
              <button
                className="text-muted-foreground hover:bg-muted/50 hover:text-foreground flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 py-6 text-center text-sm"
                onClick={() => {
                  detached(handleCreateTask(), "overview-view.create-task");
                }}
                type="button"
              >
                <PlusIcon className="size-3.5" />
                {t("tasks.newTask")}
              </button>
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
            <OverviewSectionHeader
              actionLabel={t("common.logTime")}
              icon={<ClockIcon />}
              onAction={() => {
                detached(
                  navigate({
                    to: "/workspaces/$workspaceId/timesheets",
                    params: { workspaceId },
                  }),
                  "overview-view.navigate",
                );
              }}
              title={t("workspaces.overview.timeAndTeam")}
            />
            <OverviewTimeRead view={teamTimeSummaryView}>
              {() => (
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
                        className="text-muted-foreground text-3xs text-center"
                        key={i}
                      >
                        {getLocaleDayLabel(i, firstWeekday)}
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
                                firstWeekday,
                              );
                              const opacity =
                                maxDaily > 0 ? hours / maxDaily : 0;
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
                                    // oxlint-disable-next-line react/no-array-index-key -- daily is a fixed 7-slot week array.
                                    key={dayIdx}
                                  >
                                    {cell}
                                  </div>
                                );
                              }

                              return (
                                <div
                                  className="flex size-6 items-center justify-center sm:size-7"
                                  // oxlint-disable-next-line react/no-array-index-key -- daily is a fixed 7-slot week array.
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
                                    <PopoverPopup
                                      className="w-56"
                                      sideOffset={8}
                                    >
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
              )}
            </OverviewTimeRead>
          </section>
        ) : (
          /* Personal time */
          timeBillingEnabled && (
            <section className="flex min-w-0 flex-col">
              <OverviewSectionHeader
                actionLabel={t("common.logTime")}
                icon={<ClockIcon />}
                onAction={() => {
                  detached(
                    navigate({
                      to: "/workspaces/$workspaceId/timesheets",
                      params: { workspaceId },
                    }),
                    "overview-view.navigate",
                  );
                }}
                title={t("workspaces.overview.timeThisWeek")}
              />
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
                  <div className="mt-1 text-2xl font-semibold tabular-nums">
                    <OverviewTimeRead view={timeSummaryView}>
                      {(summary) => formatHours(summary.totalMinutes / 60)}
                    </OverviewTimeRead>
                  </div>
                </div>
                <OverviewTimeTrend
                  currentHours={totalHoursThisWeek}
                  view={previousTimeSummaryView}
                />
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
            onClick: openUploadPicker,
          }}
          showHelpBar={false}
          title={tWorkspaces("emptyDocuments.title")}
        />
      )}

      <ActivityPanel key={workspaceId} workspaceId={workspaceId} />
    </div>
  );
};

type OverviewQueryView = React.ComponentProps<typeof QueryViewFeedback>["view"];

type OverviewQueryFeedbackProps = {
  flowRunsView: OverviewQueryView;
  viewsView: OverviewQueryView;
};

const OverviewQueryFeedback = ({
  flowRunsView,
  viewsView,
}: OverviewQueryFeedbackProps) => (
  <>
    <QueryViewFeedback view={viewsView} />
    {flowRunsView.type !== "pending" && (
      <QueryViewFeedback view={flowRunsView} />
    )}
  </>
);

type OverviewSectionHeaderProps = {
  icon: React.ReactNode;
  title: string;
  actionLabel: string;
  onAction: () => void;
};

/** One header anatomy for every overview panel so side-by-side panels line up. */
const OverviewSectionHeader = ({
  icon,
  title,
  actionLabel,
  onAction,
}: OverviewSectionHeaderProps) => (
  <div className="mb-3 flex h-7 items-center justify-between gap-3">
    <h2 className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-sm font-medium [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}
      <span className="truncate">{title}</span>
    </h2>
    <Button
      className="relative h-7 shrink-0 after:absolute after:-inset-2 md:after:hidden"
      onClick={onAction}
      size="sm"
      variant="ghost"
    >
      <PlusIcon className="size-3" />
      {actionLabel}
    </Button>
  </div>
);

type StatCardProps = {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
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
      <div className="text-xl font-semibold tabular-nums">{value}</div>
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
        className="bg-card hover:bg-muted/50 flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-start"
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
