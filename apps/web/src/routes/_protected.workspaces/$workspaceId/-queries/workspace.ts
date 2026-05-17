import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type JustificationsKey = {
  workspaceId: string;
  entityIds: string[];
};

export const workspaceKeys = {
  workflow: (workspaceId: string) => [
    ...workspacesKeys.byId(workspaceId),
    "workflow",
  ],
  justifications: (workspaceId: string) => [
    ...workspacesKeys.byId(workspaceId),
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
        .workspaces({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        .workflow.get({ fetch: { signal } });

      if (response.error) {
        // Workflow actor may be unavailable (cold start, timeout).
        // Return safe default instead of crashing the page.
        return WORKFLOW_DEFAULT_STATUS;
      }

      return response.data;
    },
  });

export const useIsWorkflowRunning = (inputWorkspaceId?: string) => {
  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const workspaceId = inputWorkspaceId ?? workspaceMatch?.params.workspaceId;

  const { data } = useQuery({
    ...workflowOptions({ key: { workspaceId: workspaceId ?? "" } }),
    enabled: workspaceId !== undefined,
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
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .justifications.query.post(
          { entityIds: entityIds.map((id) => toSafeId<"entity">(id)) },
          { fetch: { signal } },
        );

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
