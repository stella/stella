import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  isTaskPriority,
  isTaskStatus,
  toISODate,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import { LinksSection } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-links";
import {
  AssigneePicker,
  DatePickerPopover,
  MetadataRow,
  PrioritySelect,
  StatusSelect,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-metadata";
import { SubtasksSection } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-subtasks";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  taskDetailOptions,
  taskKeys,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/tasks";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

import type { TaskPriority, TaskStatus } from "./task-detail-constants";

// -- Component --

type TaskDetailPanelProps = {
  workspaceId: string;
  taskId: string;
};

export const TaskDetailPanel = ({
  workspaceId,
  taskId,
}: TaskDetailPanelProps) => {
  const t = useTranslations("tasks");
  const closeTab = useInspectorStore((s) => s.closeTab);
  const isNewTask = useInspectorStore((s) => {
    const found = s.tabs.find((tab) => tab.id === taskId);
    return found?.type === "task" && found.isNew;
  });
  const clearNewFlag = useInspectorStore((s) => s.clearTaskNewFlag);
  const handleClose = useCallback(() => closeTab(taskId), [closeTab, taskId]);
  const queryClient = useQueryClient();
  const userId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });

  const { data: task, isLoading } = useQuery(
    taskDetailOptions(workspaceId, taskId),
  );

  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const name = task?.name ?? t("untitled");

  const updateMutation = useMutation({
    mutationFn: async (body: {
      taskId: string;
      name?: string;
      status?: string;
      priority?: string;
      dueDate?: string | null;
    }) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          queryKey: entitiesKeys.all(workspaceId),
          ...body,
          taskId: toSafeId<"entity">(body.taskId),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: taskKeys.detail(workspaceId, taskId),
        }),
        queryClient.invalidateQueries({
          queryKey: workspacesKeys.overview(workspaceId),
        }),
      ]);
    },
  });

  // Auto-assign current user and focus name for new tasks
  const didAutoAssign = useRef(false);
  useEffect(() => {
    if (isNewTask && task && !isLoading) {
      setEditNameValue("");
      setIsEditingName(true);
      clearNewFlag(taskId);

      // Auto-assign the signed-in user
      if (!didAutoAssign.current) {
        didAutoAssign.current = true;
        const alreadyAssigned = task.assignees?.some(
          (a) => a.user.id === userId,
        );
        if (!alreadyAssigned) {
          api
            .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
            .assignees.post({
              taskId: toSafeId<"entity">(taskId),
              userId: toSafeId<"user">(userId),
              queryKey: entitiesKeys.all(workspaceId),
            })
            .then(async () => {
              await Promise.all([
                queryClient.invalidateQueries({
                  queryKey: taskKeys.detail(workspaceId, taskId),
                }),
                queryClient.invalidateQueries({
                  queryKey: workspacesKeys.overview(workspaceId),
                }),
              ]);
            })
            .catch(() => {
              /* non-critical */
            });
        }
      }
    }
  }, [
    isNewTask,
    task,
    isLoading,
    clearNewFlag,
    taskId,
    userId,
    workspaceId,
    queryClient,
  ]);

  const startEditingName = () => {
    setEditNameValue(task?.name ?? "");
    setIsEditingName(true);
  };

  const commitName = () => {
    const trimmed = editNameValue.trim();
    if (trimmed && trimmed !== (task?.name ?? "")) {
      updateMutation.mutate({ taskId, name: trimmed });
    }
    setIsEditingName(false);
  };

  const handleStatusChange = (value: TaskStatus | null) => {
    if (!value) {
      return;
    }
    updateMutation.mutate({ taskId, status: value });
  };

  const handlePriorityChange = (value: TaskPriority | null) => {
    if (!value) {
      return;
    }
    updateMutation.mutate({ taskId, priority: value });
  };

  const handleDueDateChange = (value: string | null) => {
    updateMutation.mutate({ taskId, dueDate: value });
  };

  const handleSubtaskToggle = (
    subtaskId: string,
    currentStatus: string | null,
  ) => {
    const newStatus = currentStatus === "done" ? "open" : "done";
    updateMutation.mutate({
      taskId: subtaskId,
      status: newStatus,
    });
  };

  // Sync task status to the inspector tab icon so the vertical
  // tab bar reflects the current status color.
  const resolvedStatus = task
    ? isTaskStatus(task.status)
      ? task.status
      : "open"
    : null;
  useEffect(() => {
    if (resolvedStatus !== null) {
      useInspectorStore.getState().updateTaskStatus(taskId, resolvedStatus);
    }
  }, [taskId, resolvedStatus]);

  if (isLoading) {
    return (
      <div className="bg-background flex h-full min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex items-center gap-1 border-b px-2",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className="h-4 flex-1" />
          <Button onClick={handleClose} size="icon-xs" variant="ghost">
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="space-y-3 px-4 py-3">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-3/4" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="bg-background flex h-full min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex items-center gap-1 border-b px-2",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <span className="text-muted-foreground flex-1 text-xs">
            Task not found
          </span>
          <Button onClick={handleClose} size="icon-xs" variant="ghost">
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  const currentStatus = isTaskStatus(task.status) ? task.status : "open";
  const currentPriority = isTaskPriority(task.priority)
    ? task.priority
    : "none";

  const dueDateISO = toISODate(task.dueDate);
  const isOverdue =
    dueDateISO &&
    currentStatus !== "done" &&
    currentStatus !== "cancelled" &&
    dueDateISO < new Date().toISOString().slice(0, 10);

  return (
    <div className="bg-background flex h-full min-w-0 flex-1 flex-col">
      {/* Header */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b px-2",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {isNewTask ? t("newTask") : name}
        </span>
        <Button onClick={handleClose} size="icon-xs" variant="ghost">
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {/* Editable task name */}
        <div className="px-4 pt-3 pb-2">
          {isEditingName ? (
            <Input
              autoFocus
              className="text-base font-semibold"
              onBlur={commitName}
              onChange={(e) => setEditNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  setIsEditingName(false);
                  setEditNameValue(task?.name ?? "");
                }
              }}
              placeholder={t("untitled")}
              ref={nameInputRef}
              value={editNameValue}
            />
          ) : (
            <button
              className="hover:text-foreground/80 w-full text-start text-base font-semibold transition-colors"
              onClick={startEditingName}
              type="button"
            >
              {name}
            </button>
          )}
        </div>

        {/* Metadata */}
        <div className="space-y-3 px-4 py-3">
          <MetadataRow label={t("status")}>
            <StatusSelect onChange={handleStatusChange} value={currentStatus} />
          </MetadataRow>

          <MetadataRow label={t("priority")}>
            <PrioritySelect
              onChange={handlePriorityChange}
              value={currentPriority}
            />
          </MetadataRow>

          <MetadataRow label={t("dueDate")}>
            <DatePickerPopover
              isOverdue={isOverdue === true}
              onChange={handleDueDateChange}
              value={task.dueDate}
            />
          </MetadataRow>

          <MetadataRow label={t("assignees")}>
            <AssigneePicker
              assignees={task.assignees ?? []}
              taskId={taskId}
              workspaceId={workspaceId}
            />
          </MetadataRow>
        </div>

        {/* Subtasks */}
        <SubtasksSection
          onToggle={handleSubtaskToggle}
          subtasks={task.children ?? []}
        />

        {/* Links */}
        <LinksSection
          linkedFrom={task.linksAsSource ?? []}
          linkedTo={task.linksAsTarget ?? []}
        />
      </ScrollArea>
    </div>
  );
};
