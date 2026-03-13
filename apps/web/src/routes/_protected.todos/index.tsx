import { useMemo, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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

import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import { cn } from "@stella/ui/lib/utils";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { pageTitle } from "@/lib/page-title";
import { myTasksOptions } from "@/routes/_protected.todos/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

type TaskFilter = "all" | "open" | "in_progress" | "done";

export const Route = createFileRoute("/_protected/todos/")({
  head: () => ({
    meta: [{ title: pageTitle("navigation.myTodos") }],
  }),
  component: MyTodosPage,
});

const STATUS_COLORS: Record<string, string> = {
  open: "bg-muted-foreground",
  in_progress: "bg-blue-500",
  in_review: "bg-amber-500",
  done: "bg-green-500",
  cancelled: "bg-red-400",
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
  urgent: "text-red-500",
  high: "text-orange-500",
  medium: "text-yellow-500",
  low: "text-blue-400",
};

type TaskItem = {
  id: string;
  name: string | null;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  workspaceId: string;
  createdAt: Date | string;
  workspace: {
    id: string;
    name: string;
  } | null;
};

type ValidTask = TaskItem & {
  workspace: { id: string; name: string };
};

type GroupedTasks = {
  workspace: { id: string; name: string };
  tasks: ValidTask[];
};

const groupByWorkspace = (tasks: ValidTask[]): GroupedTasks[] => {
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
  const [filter, setFilter] = useState<TaskFilter>("all");
  const { data: tasks, isLoading } = useQuery(myTasksOptions);
  const { data: workspaces } = useQuery(workspacesOptions);

  const filtered = useMemo(() => {
    if (!tasks) {
      return [];
    }

    // Filter out tasks without a workspace (shouldn't
    // happen, but satisfies the type constraint).
    const valid = (tasks as TaskItem[]).filter(
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
    if (!entityId) {
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
        <h1 className="mr-auto text-lg font-semibold">
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
                  onClick={async () => {
                    await handleCreateTask(ws.id);
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
