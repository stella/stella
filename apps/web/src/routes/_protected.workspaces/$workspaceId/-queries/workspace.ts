import { queryOptions, useQuery } from "@tanstack/react-query";
import { useParams, useRouteContext } from "@tanstack/react-router";

import { getWorkflowActorConfig } from "@stella/rivet/actors/workflow-actor-config";
import { withTimeout } from "@stella/rivet/timeout";

import { api, rivet } from "@/lib/api";
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

type WorkflowOptionsInput = QueryOptionsInput<
  { workspaceId: string },
  { organizationId: string; authToken: string }
>;

const WORKFLOW_STATUS_TIMEOUT_MS = 10_000;

export const workflowOptions = ({ key, context }: WorkflowOptionsInput) =>
  queryOptions({
    queryKey: workspaceKeys.workflow(key.workspaceId),
    queryFn: async ({ signal }) => {
      const actorConfig = getWorkflowActorConfig({
        type: "vanilla",
        organizationId: context.organizationId,
        authToken: context.authToken,
        workspaceId: key.workspaceId,
      });

      const handle = rivet.workflow.getOrCreate(actorConfig[0], {
        ...actorConfig[1],
        signal,
      });

      return await withTimeout({
        signal,
        timeoutMs: WORKFLOW_STATUS_TIMEOUT_MS,
        timeoutMessage: "Workflow actor timed out",
        run: async () => await handle.getWorkflowStatus(),
      });
    },
  });

export const useIsWorkflowRunning = () => {
  const { authToken, organizationId } = useRouteContext({
    from: "/_protected/workspaces/$workspaceId",
    select: (ctx) => ({
      authToken: ctx.authToken,
      organizationId: ctx.user?.activeOrganizationId,
    }),
  });
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (s) => s.workspaceId,
  });

  const { data } = useQuery({
    ...workflowOptions({
      key: { workspaceId },
      context: { organizationId, authToken },
    }),
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
