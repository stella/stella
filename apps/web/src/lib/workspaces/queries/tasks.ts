import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

export { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

const getTaskEndpoint = (workspaceId: string, taskId: string) =>
  api.tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })({
    taskId: toSafeId<"entity">(taskId),
  });

export const taskDetailOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: taskKeys.detail(workspaceId, taskId),
    retry: shouldRetryAPIRequest,
    queryFn: async ({ signal }) => {
      const endpoint = getTaskEndpoint(workspaceId, taskId);
      const response = await endpoint.get({
        fetch: { signal },
      });
      return unwrapEden(response);
    },
    enabled: !!taskId,
  });
