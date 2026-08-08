import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { isEntityPriority, isTaskStatus } from "@stll/api-contract";
import type { EntityPriority, TaskStatus } from "@stll/api-contract";
import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterRefLink } from "@/components/matter-ref-link";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { localISODate } from "@/lib/local-iso-date";
import { toSafeId } from "@/lib/safe-id";
import { captureInvalidTaskOption } from "@/lib/task-option-telemetry";
import { workspacesOptions } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import type {
  MyTasksStatus,
  TaskItem,
} from "@/lib/workspaces/queries/my-tasks";
import {
  MY_TASKS_STATUSES,
  myTasksKeys,
  myTasksOptions,
} from "@/lib/workspaces/queries/my-tasks";

const protectedRouteApi = getRouteApi("/_protected");

type TaskFilter = "all" | MyTasksStatus;

const STATUS_COLORS = {
  open: "bg-muted-foreground",
  in_progress: "bg-foreground-strong-muted dark:bg-foreground-strong-muted",
  in_review: "bg-warning",
  done: "bg-success dark:bg-success",
  cancelled: "bg-destructive dark:bg-destructive",
} as const satisfies Record<TaskStatus, string>;

const PRIORITY_ICONS = {
  none: MinusIcon,
  urgent: AlertCircleIcon,
  high: ArrowUpIcon,
  medium: MinusIcon,
  low: ArrowDownIcon,
} as const satisfies Record<EntityPriority, typeof MinusIcon>;

const PRIORITY_COLORS = {
  none: "text-muted-foreground",
  urgent: "text-destructive",
  high: "text-warning",
  medium: "text-warning",
  low: "text-foreground-muted dark:text-foreground",
} as const satisfies Record<EntityPriority, string>;

const SKELETON_GROUP_KEYS = ["alpha", "beta", "gamma"];
const SKELETON_ROW_KEYS = ["one", "two", "three"];
// Vary the name-bar width per row so the skeleton reads as a real task list
// rather than a uniform block.
const SKELETON_ROW_NAME_WIDTHS: Record<string, string> = {
  one: "w-48",
  two: "w-64",
  three: "w-40",
};

const compareStableStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

type ValidTask = TaskItem & {
  workspace: NonNullable<TaskItem["workspace"]>;
};

type GroupedTasks = {
  workspace: { id: string; name: string };
  tasks: ValidTask[];
};

const groupByWorkspace = (tasks: readonly ValidTask[]): GroupedTasks[] => {
  const map = new Map<string, GroupedTasks>();

  for (const task of tasks) {
    const existing = map.get(task.workspace.id);
    if (existing) {
      existing.tasks.push(task);
    } else {
      map.set(task.workspace.id, {
        workspace: task.workspace,
        tasks: [task],
      });
    }
  }

  return Array.from(map.values());
};

export function LegacyTodosPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { activeOrganizationId, userId } = protectedRouteApi.useRouteContext({
    select: (ctx) => ({
      activeOrganizationId: ctx.user.activeOrganizationId,
      userId: ctx.user.id,
    }),
  });
  const [filter, setFilter] = useState<TaskFilter>("all");
  const {
    data,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery(
    myTasksOptions(activeOrganizationId, filter === "all" ? null : filter),
  );
  const { data: workspaces } = useQuery(
    workspacesOptions(activeOrganizationId),
  );

  const tasks = data ? data.pages.flatMap((page) => page.items) : [];
  const filtered = (() => {
    const valid = tasks
      .filter((task): task is ValidTask => task.workspace !== null)
      .toSorted((left, right) => {
        if (left.dueDate === right.dueDate) {
          return compareStableStrings(left.id, right.id);
        }
        if (left.dueDate === null) {
          return 1;
        }
        if (right.dueDate === null) {
          return -1;
        }
        return compareStableStrings(left.dueDate, right.dueDate);
      });

    return valid;
  })();

  const groups = groupByWorkspace(filtered);

  useExternalSyncEffect(() => {
    if (!queryError) {
      return;
    }
    analytics.captureError(queryError);
    stellaToast.error(
      userErrorFromThrown(queryError, t("common.unexpectedError")),
    );
  }, [analytics, queryError, t]);

  const createTaskMutation = useMutation({
    mutationFn: async (wsId: string) => {
      const response = await api.tasks({ workspaceId: wsId }).put({
        assigneeIds: [toSafeId<"user">(userId)],
        queryKey: entitiesKeys.all(wsId),
        name: t("tasks.untitled"),
      });

      const entityId = unwrapEden(response).entityId;
      await queryClient.invalidateQueries({ queryKey: myTasksKeys.all });

      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: wsId },
      });
      useInspectorTabsStore
        .getState()
        .openTask({ taskId: entityId, workspaceId: wsId, isNew: true });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.error(
        userErrorFromThrown(error, t("common.unexpectedError")),
      );
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-lg font-semibold">
          {t("tasks.myTasksTitle")}
        </h1>
        {workspaces?.workspaces && workspaces.workspaces.length > 0 && (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              <PlusIcon />
              {t("tasks.newTask")}
            </MenuTrigger>
            <MenuPopup>
              {workspaces.workspaces.map((ws) => (
                <MenuItem
                  key={ws.id}
                  onClick={() => {
                    createTaskMutation.mutate(ws.id);
                  }}
                >
                  {ws.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
        <div className="flex flex-wrap gap-1">
          <FilterButton
            active={filter === "all"}
            label={t("common.all")}
            onClick={() => setFilter("all")}
          />
          {MY_TASKS_STATUSES.map((status) => (
            <FilterButton
              active={filter === status}
              key={status}
              label={t(`tasks.statusValues.${status}`)}
              onClick={() => setFilter(status)}
            />
          ))}
        </div>
      </div>

      {isLoading && <TasksLoadingSkeleton />}

      {!isLoading && !queryError && groups.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16">
          <EntityKindIcon className="size-10 opacity-40" kind="task" />
          <p className="text-sm">{t("tasks.noTasksAssigned")}</p>
          {workspaces?.workspaces && workspaces.workspaces.length > 0 && (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="default">
                    <PlusIcon />
                    {t("tasks.newTask")}
                  </Button>
                }
              />
              <MenuPopup>
                {workspaces.workspaces.map((ws) => (
                  <MenuItem
                    key={ws.id}
                    onClick={() => {
                      createTaskMutation.mutate(ws.id);
                    }}
                  >
                    {ws.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          )}
        </div>
      )}

      {groups.map((group) => (
        <div className="flex flex-col gap-1" key={group.workspace.id}>
          <h2 className="text-muted-foreground px-1 text-xs font-medium">
            {group.workspace.name}
          </h2>
          <div className="flex flex-col">
            {group.tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </div>
      ))}

      {queryError && groups.length === 0 && (
        <p className="text-destructive py-16 text-center text-sm" role="alert">
          {userErrorFromThrown(queryError, t("common.unexpectedError"))}
        </p>
      )}

      {hasNextPage && (
        <Button
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "LegacyTodosPage");
          }}
          size="sm"
          variant="outline"
        >
          {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
        </Button>
      )}
    </div>
  );
}

type FilterButtonProps = {
  label: string;
  active: boolean;
  onClick: () => void;
};

const FilterButton = ({ label, active, onClick }: FilterButtonProps) => (
  <Button onClick={onClick} size="sm" variant={active ? "default" : "outline"}>
    {label}
  </Button>
);

const TaskRow = ({ task }: { task: ValidTask }) => {
  const status = isTaskStatus(task.status) ? task.status : null;
  const priority = isEntityPriority(task.priority) ? task.priority : null;

  useExternalSyncEffect(() => {
    if (status === null) {
      captureInvalidTaskOption("status");
    }
    if (priority === null) {
      captureInvalidTaskOption("priority");
    }
  }, [priority, status]);

  const statusColor =
    status === null ? STATUS_COLORS.open : STATUS_COLORS[status];

  const PriorityIcon = priority === null ? null : PRIORITY_ICONS[priority];
  const priorityColor = priority === null ? null : PRIORITY_COLORS[priority];

  const isOverdue =
    task.dueDate !== null &&
    task.status !== "done" &&
    task.status !== "cancelled" &&
    task.dueDate < localISODate();

  return (
    <MatterRefLink
      className="group hover:bg-muted/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors"
      onClick={() => {
        useInspectorTabsStore.getState().openTask({
          taskId: task.id,
          workspaceId: task.workspaceId,
          label: task.name,
        });
      }}
      workspaceId={task.workspaceId}
    >
      <span className={cn("size-2 shrink-0 rounded-full", statusColor)} />
      <span className="min-w-0 flex-1 truncate">{task.name}</span>
      {PriorityIcon && priorityColor && (
        <PriorityIcon className={cn("size-3.5 shrink-0", priorityColor)} />
      )}
      {task.dueDate && (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1",
            "text-muted-foreground text-xs",
            isOverdue && "text-destructive",
          )}
        >
          <CalendarIcon className="size-3" />
          {new Date(task.dueDate).toLocaleDateString(getFormattingLocale(), {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </span>
      )}
    </MatterRefLink>
  );
};

// Mirrors the loaded grouped-list layout (group header + task rows) so only the
// values fade in when data lands, instead of a layout shift from blank to list.
const TasksLoadingSkeleton = () => (
  <>
    {SKELETON_GROUP_KEYS.map((groupKey) => (
      <div className="flex flex-col gap-1" key={groupKey}>
        <Skeleton className="mx-1 h-4 w-32" />
        <div className="flex flex-col">
          {SKELETON_ROW_KEYS.map((rowKey) => (
            <div
              className="flex items-center gap-3 px-2 py-1.5"
              key={`${groupKey}-${rowKey}`}
            >
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton
                className={cn("h-4", SKELETON_ROW_NAME_WIDTHS[rowKey])}
              />
              <Skeleton className="ms-auto size-3.5 shrink-0 rounded-sm" />
              <Skeleton className="h-4 w-14 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    ))}
  </>
);
