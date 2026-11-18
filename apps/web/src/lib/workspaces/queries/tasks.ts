import { queryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { api } from "@/lib/api";
import { shouldRetryAPIRequest, unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

export { taskKeys } from "@/lib/workspaces/queries/tasks.logic";

const getTaskEndpoint = (workspaceId: string, taskId: string) =>
  api.tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })({
    taskId: toSafeId<"entity">(taskId),
  });

type TaskDetailOptionsInput = {
  workspaceId: string;
  taskId: string;
  organizationId: string;
};

export const taskDetailOptions = ({
  workspaceId,
  taskId,
  organizationId,
}: TaskDetailOptionsInput) =>
  resourceQueryOptions(
    queryOptions({
      queryKey: taskKeys.detail(workspaceId, taskId),
      retry: shouldRetryAPIRequest,
      queryFn: async ({ signal }) => {
        const endpoint = getTaskEndpoint(workspaceId, taskId);
        const response = await endpoint.get({
          fetch: { signal },
        });
        return unwrapApiResponse(response);
      },
      enabled: !!taskId,
    }),
    {
      resources: [RESOURCE_TYPE.ENTITY],
      scope: { type: "workspace", workspaceId },
      organizationReads: { organizationId, resources: [RESOURCE_TYPE.USER] },
    },
  );
