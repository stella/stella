import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

export const taskKeys = {
  all: (workspaceId: string) => ["tasks", workspaceId],
  detail: (workspaceId: string, taskId: string) => [
    ...taskKeys.all(workspaceId),
    taskId,
  ],
};

const getTaskEndpoint = (workspaceId: string, taskId: string) =>
  api.tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })({
    taskId: toSafeId<"entity">(taskId),
  });

export const taskDetailOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: taskKeys.detail(workspaceId, taskId),
    queryFn: async ({ signal }) => {
      const endpoint = getTaskEndpoint(workspaceId, taskId);
      const response = await endpoint.get({
        fetch: { signal },
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    enabled: !!taskId,
  });
