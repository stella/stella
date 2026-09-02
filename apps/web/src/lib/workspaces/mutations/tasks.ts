import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { taskKeys } from "@/lib/workspaces/queries/tasks";

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
  });
};

/** Remove one member's assignment from a task. */
export const useRemoveTaskAssignee = (workspaceId: string) => {
  const queryClient = useQueryClient();

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
  });
};
