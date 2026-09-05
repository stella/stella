import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";
import { taskKeys } from "@/lib/workspaces/queries/tasks";

/** Create an untitled task and open it in the inspector for naming. */
export const useCreateTask = () => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: async (workspaceId: string) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({ name: t("tasks.untitled") });
      return unwrapEden(response);
    },
    onSuccess: async (data, workspaceId) => {
      stellaToast.add({
        title: t("success.taskCreated"),
        type: "success",
      });
      useInspectorTabsStore.getState().openTask({
        taskId: data.entityId,
        workspaceId,
        isNew: true,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: workspacesKeys.overview(workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: myWorkKeys.all }),
      ]);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};

type TaskAssigneeVars = {
  taskId: string;
  userId: string;
};

const invalidateTaskAssigneeQueries = async (
  queryClient: QueryClient,
  workspaceId: string,
  taskId: string,
) => {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: taskKeys.detail(workspaceId, taskId),
    }),
    queryClient.invalidateQueries({
      queryKey: entitiesKeys.all(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: workspacesKeys.overview(workspaceId),
    }),
  ]);
};

/** Assign one member to a task, in the role tasks.assignees-add defaults to. */
export const useAddTaskAssignee = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({ taskId, userId }: TaskAssigneeVars) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .assignees.post({
          taskId: toSafeId<"entity">(taskId),
          userId: toSafeId<"user">(userId),
        });
      return unwrapEden(response);
    },
    onSuccess: async (_data, { taskId }) => {
      await invalidateTaskAssigneeQueries(queryClient, workspaceId, taskId);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};

/** Remove one member's assignment from a task. */
export const useRemoveTaskAssignee = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({ taskId, userId }: TaskAssigneeVars) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .assignees.delete({
          taskId: toSafeId<"entity">(taskId),
          userId: toSafeId<"user">(userId),
        });
      return unwrapEden(response);
    },
    onSuccess: async (_data, { taskId }) => {
      await invalidateTaskAssigneeQueries(queryClient, workspaceId, taskId);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};

type MoveTaskAssigneeVars = {
  taskId: string;
  fromUserId: string | null;
  toUserId: string | null;
};

/**
 * Reassign a task from one member to another in one atomic request (see
 * tasks.assignees-move): a kanban lane drag calls this once instead of
 * pairing useRemoveTaskAssignee and useAddTaskAssignee, so a failed add can
 * never leave the task with neither assignee.
 */
export const useMoveTaskAssignee = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const t = useTranslations();

  return useMutation({
    mutationFn: async ({
      taskId,
      fromUserId,
      toUserId,
    }: MoveTaskAssigneeVars) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .assignees.move.post({
          taskId: toSafeId<"entity">(taskId),
          fromUserId: fromUserId === null ? null : toSafeId<"user">(fromUserId),
          toUserId: toUserId === null ? null : toSafeId<"user">(toUserId),
        });
      return unwrapEden(response);
    },
    onSuccess: async (_data, { taskId }) => {
      await invalidateTaskAssigneeQueries(queryClient, workspaceId, taskId);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};
