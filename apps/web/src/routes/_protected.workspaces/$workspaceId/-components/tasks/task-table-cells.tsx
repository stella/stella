import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { WorkspaceEntity } from "@/lib/types";
import type {
  TaskPriority,
  TaskStatus,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import {
  isTaskPriority,
  isTaskStatus,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import {
  DatePickerPopover,
  PrioritySelect,
  StatusSelect,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-metadata";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { taskKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/tasks";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

// -- Shared mutation hook --

const useUpdateTask = (workspaceId: string, taskId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: async (body: {
      taskId: string;
      status?: string;
      priority?: string;
      dueDate?: string | null;
    }) => {
      const response = await api.tasks({ workspaceId }).patch({
        queryKey: entitiesKeys.all(workspaceId),
        ...body,
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
          queryKey: workspacesKeys.overview(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: taskKeys.detail(workspaceId, taskId),
        }),
      ]);
    },
    onError: (error) => {
      analytics.captureError(error);
      toastManager.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};

// -- Status cell --

export type EditableCellProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
};

export const StatusCell = ({ entity, workspaceId }: EditableCellProps) => {
  const updateTask = useUpdateTask(workspaceId, entity.entityId);

  if (entity.kind !== "task" || !entity.status) {
    return null;
  }

  const currentStatus: TaskStatus = isTaskStatus(entity.status)
    ? entity.status
    : "open";

  const handleChange = (value: TaskStatus | null) => {
    if (!value || value === currentStatus) {
      return;
    }
    updateTask.mutate({ taskId: entity.entityId, status: value });
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="-mx-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <StatusSelect onChange={handleChange} value={currentStatus} />
    </div>
  );
};

// -- Priority cell --

export const PriorityCell = ({ entity, workspaceId }: EditableCellProps) => {
  const updateTask = useUpdateTask(workspaceId, entity.entityId);

  if (entity.kind !== "task" || !entity.priority) {
    return null;
  }

  const currentPriority: TaskPriority = isTaskPriority(entity.priority)
    ? entity.priority
    : "none";

  const handleChange = (value: TaskPriority | null) => {
    if (!value || value === currentPriority) {
      return;
    }
    updateTask.mutate({ taskId: entity.entityId, priority: value });
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="-mx-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <PrioritySelect onChange={handleChange} value={currentPriority} />
    </div>
  );
};

// -- Due date cell --

export const DueDateCell = ({ entity, workspaceId }: EditableCellProps) => {
  const updateTask = useUpdateTask(workspaceId, entity.entityId);

  if (entity.kind !== "task") {
    return null;
  }

  const isOverdue =
    entity.dueDate &&
    entity.status !== "done" &&
    entity.status !== "cancelled" &&
    entity.dueDate < new Date().toISOString().slice(0, 10);

  const handleChange = (value: string | null) => {
    updateTask.mutate({ taskId: entity.entityId, dueDate: value });
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="-mx-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <DatePickerPopover
        isOverdue={isOverdue === true}
        onChange={handleChange}
        value={entity.dueDate}
      />
    </div>
  );
};
