import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  ListTodoIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";

import { getFormattingLocale } from "@/i18n/i18n-store";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { pageTitle } from "@/lib/page-title";
import type { TaskItem } from "@/routes/_protected.todos/-queries";
import { myTasksOptions } from "@/routes/_protected.todos/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { MatterRefLink } from "@/routes/_protected.workspaces/-components/matter-ref-link";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

const protectedRouteApi = getRouteApi("/_protected");

type TaskFilter = "all" | "open" | "in_progress" | "done";

export const Route = createFileRoute("/_protected/todos/")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.myTodos") }],
  }),
  component: MyTodosPage,
});

const STATUS_COLORS: Record<string, string> = {
  open: "bg-muted-foreground",
  in_progress: "bg-foreground-strong-muted dark:bg-foreground-strong-muted",
  in_review: "bg-warning",
  done: "bg-success dark:bg-success",
  cancelled: "bg-destructive dark:bg-destructive",
};

const PRIORITY_ICONS: Record<string, typeof MinusIcon> = {
  none: MinusIcon,
  urgent: AlertCircleIcon,
  high: ArrowUpIcon,
  medium: MinusIcon,
  low: ArrowDownIcon,
};

const PRIORITY_COLORS: Record<string, string> = {
  none: "text-muted-foreground",
  urgent: "text-destructive",
  high: "text-warning",
  medium: "text-warning",
  low: "text-foreground-muted dark:text-foreground",
};

const SKELETON_GROUP_KEYS = ["alpha", "beta", "gamma"];
const SKELETON_ROW_KEYS = ["one", "two", "three"];
// Vary the name-bar width per row so the skeleton reads as a real task list
// rather than a uniform block.
const SKELETON_ROW_NAME_WIDTHS: Record<string, string> = {
  one: "w-48",
  two: "w-64",
  three: "w-40",
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

function MyTodosPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [filter, setFilter] = useState<TaskFilter>("all");
  const { data: tasks, isLoading } = useQuery(myTasksOptions);
  const { data: workspaces } = useQuery(
    workspacesOptions(activeOrganizationId),
  );

  const filtered = (() => {
    if (!tasks) {
      return [];
    }

    const valid = tasks.filter(
      (task): task is ValidTask => task.workspace !== null,
    );

    if (filter === "all") {
      return valid;
    }
    return valid.filter((task) => task.status === filter);
  })();

  const groups = groupByWorkspace(filtered);

  const handleCreateTask = async (wsId: string) => {
    const response = await api.tasks({ workspaceId: wsId }).put({
      queryKey: entitiesKeys.all(wsId),
      name: t("tasks.untitled"),
    });

    const entityId = unwrapEden(response).entityId;

    await navigate({
      to: "/workspaces/$workspaceId",
      params: { workspaceId: wsId },
    });
    useInspectorStore
      .getState()
      .openTask({ taskId: entityId, workspaceId: wsId, isNew: true });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t p-4">
      <div className="flex items-center gap-2">
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
                    detached(
                      (async () => {
                        await handleCreateTask(ws.id);
                      })(),
                      "MyTodosPage",
                    );
                  }}
                >
                  {ws.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
        <div className="flex gap-1">
          <FilterButton
            active={filter === "all"}
            label={t("common.all")}
            onClick={() => setFilter("all")}
          />
          <FilterButton
            active={filter === "open"}
            label={t("tasks.statusValues.open")}
            onClick={() => setFilter("open")}
          />
          <FilterButton
            active={filter === "in_progress"}
            label={t("tasks.statusValues.in_progress")}
            onClick={() => setFilter("in_progress")}
          />
          <FilterButton
            active={filter === "done"}
            label={t("tasks.statusValues.done")}
            onClick={() => setFilter("done")}
          />
        </div>
      </div>

      {isLoading && <TasksLoadingSkeleton />}

      {!isLoading && groups.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16">
          <ListTodoIcon className="size-10 opacity-40" />
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
                      detached(
                        (async () => {
                          await handleCreateTask(ws.id);
                        })(),
                        "MyTodosPage",
                      );
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
  const statusColor =
    STATUS_COLORS[task.status ?? "open"] ?? "bg-muted-foreground";

  const PriorityIcon = task.priority
    ? (PRIORITY_ICONS[task.priority] ?? MinusIcon)
    : null;
  const priorityColor = task.priority
    ? (PRIORITY_COLORS[task.priority] ?? "text-muted-foreground")
    : null;

  const isOverdue =
    task.dueDate !== null &&
    task.status !== "done" &&
    task.status !== "cancelled" &&
    task.dueDate < new Date().toISOString().slice(0, 10);

  return (
    <MatterRefLink
      className="group hover:bg-muted/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors"
      onClick={() => {
        useInspectorStore.getState().openTask({
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
