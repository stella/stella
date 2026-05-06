import { useMemo, useState } from "react";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { cn } from "@stll/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  getRouteApi,
  Link,
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

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { pageTitle } from "@/lib/page-title";
import type { TaskItem } from "@/routes/_protected.todos/-queries";
import { myTasksOptions } from "@/routes/_protected.todos/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
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
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  in_progress: "bg-blue-500 dark:bg-blue-400",
  in_review: "bg-amber-500",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  done: "bg-green-500 dark:bg-green-400",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  cancelled: "bg-red-400 dark:bg-red-300",
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
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  urgent: "text-red-500 dark:text-red-400",
  high: "text-orange-500",
  medium: "text-yellow-500",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  low: "text-blue-400 dark:text-blue-300",
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

  const filtered = useMemo(() => {
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
  }, [tasks, filter]);

  const groups = useMemo(() => groupByWorkspace(filtered), [filtered]);

  const handleCreateTask = async (wsId: string) => {
    const response = await api.tasks({ workspaceId: wsId }).put({
      queryKey: entitiesKeys.all(wsId),
      name: t("tasks.untitled"),
    });

    if (response.error) {
      throw toAPIError(response.error);
    }

    const entityId = response.data?.entityId;
    if (entityId === undefined) {
      return;
    }

    await navigate({
      to: "/workspaces/$workspaceId",
      params: { workspaceId: wsId },
    });
    useInspectorStore.getState().openTask(entityId, "", true);
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
                  // eslint-disable-next-line typescript/no-misused-promises
                  onClick={() => {
                    void (async () => {
                      await handleCreateTask(ws.id);
                    })();
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
                    // eslint-disable-next-line typescript/no-misused-promises
                    onClick={() => {
                      void (async () => {
                        await handleCreateTask(ws.id);
                      })();
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
    <Link
      className="group hover:bg-muted/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors"
      onClick={() => {
        useInspectorStore.getState().openTask(task.id, task.name ?? "");
      }}
      params={{ workspaceId: task.workspaceId }}
      to="/workspaces/$workspaceId"
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
            isOverdue && "text-red-500",
          )}
        >
          <CalendarIcon className="size-3" />
          {new Date(task.dueDate).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </span>
      )}
    </Link>
  );
};
