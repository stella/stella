import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { APIError, unwrapEden } from "@/lib/errors/api";
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
    retry: (failureCount, error) =>
      failureCount < 3 && (!APIError.is(error) || error.status >= 500),
    queryFn: async ({ signal }) => {
      const endpoint = getTaskEndpoint(workspaceId, taskId);
      const response = await endpoint.get({
        fetch: { signal },
      });
      return unwrapEden(response);
    },
    enabled: !!taskId,
  });
