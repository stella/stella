import { queryOptions, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type JustificationsKey = {
  workspaceId: string;
  entityIds: string[];
};

export const workspaceKeys = {
  workflow: (workspaceId: string) => [
    ...workspacesKeys.all,
    workspaceId,
    "workflow",
  ],
  justifications: (workspaceId: string) => [
    ...workspacesKeys.all,
    workspaceId,
    "justifications",
  ],
  justificationsByEntities: ({ workspaceId, entityIds }: JustificationsKey) => [
    ...workspaceKeys.justifications(workspaceId),
    { entityIds },
  ],
};

type WorkflowKey = { workspaceId: string };

const WORKFLOW_DEFAULT_STATUS = { running: false } as const;

export const workflowOptions = ({ key }: { key: WorkflowKey }) =>
  queryOptions({
    queryKey: workspaceKeys.workflow(key.workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: key.workspaceId })
        .workflow.get({ fetch: { signal } });

      if (response.error) {
        // Workflow actor may be unavailable (cold start, timeout).
        // Return safe default instead of crashing the page.
        return WORKFLOW_DEFAULT_STATUS;
      }

      return response.data;
    },
  });

export const useIsWorkflowRunning = () => {
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (s) => s.workspaceId,
  });

  const { data } = useQuery({
    ...workflowOptions({ key: { workspaceId } }),
    select: (d) => d.running,
  });

  return data ?? false;
};

type JustificationsOptionsInput = QueryOptionsInput<JustificationsKey>;

export const justificationsOptions = ({
  workspaceId,
  entityIds,
}: JustificationsOptionsInput) =>
  queryOptions({
    queryKey: workspaceKeys.justificationsByEntities({
      workspaceId,
      entityIds,
    }),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .justifications.query.post({ entityIds }, { fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
