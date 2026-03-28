import { queryOptions, useQuery } from "@tanstack/react-query";
import { useParams, useRouteContext } from "@tanstack/react-router";

import { getWorkflowActorConfig } from "@stella/rivet/actors/workflow-actor-config";

import { api, rivet } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { APIError, toAPIError, toAuthClientError } from "@/lib/errors";
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

type WorkflowOptionsProps = {
  workspaceId: string;
  organizationId: string;
};

export const workflowOptions = ({
  workspaceId,
  organizationId,
}: WorkflowOptionsProps) =>
  queryOptions({
    queryKey: workspaceKeys.workflow(workspaceId),
    queryFn: async ({ signal }) => {
      const sessionData = await authClient.getSession();

      if (sessionData.error) {
        throw toAuthClientError(sessionData.error);
      }

      const authToken = sessionData.data?.session.token;

      if (!authToken) {
        throw new APIError({
          status: 401,
          message: "Workflow query called without a valid session",
        });
      }

      const actorConfig = getWorkflowActorConfig({
        type: "vanilla",
        organizationId,
        authToken,
        workspaceId,
      });

      const handle = rivet.workflow.getOrCreate(actorConfig[0], {
        ...actorConfig[1],
        signal,
      });

      return handle.getWorkflowStatus();
    },
  });

export const useIsWorkflowRunning = () => {
  const organizationId = useRouteContext({
    from: "/_protected/workspaces/$workspaceId",
    select: (ctx) => ctx.user?.activeOrganizationId,
  });
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (s) => s.workspaceId,
  });

  const { data } = useQuery({
    ...workflowOptions({
      workspaceId,
      organizationId,
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
