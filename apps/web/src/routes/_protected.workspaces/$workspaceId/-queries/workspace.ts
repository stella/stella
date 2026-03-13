import { queryOptions, useQuery } from "@tanstack/react-query";
import { useParams, useRouteContext } from "@tanstack/react-router";

import { getWorkflowActorConfig } from "@stella/rivet/actors/workflow-actor-config";

import { api, rivet } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { STALE_TIME } from "@/lib/consts";
import { APIError, toAPIError, toAuthClientError } from "@/lib/errors";
import { withActorTimeout } from "@/lib/rivet";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

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
    staleTime: STALE_TIME.FIVE.MINUTES,
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

      const rivetActor = rivet.workflow.getOrCreate(
        ...withActorTimeout(actorConfig, signal),
      );

      const workflowStatus = await rivetActor.getWorkflowStatus();

      return workflowStatus;
    },
  });

export const useIsWorkflowRunning = () => {
  const organizationId = useRouteContext({
    from: "/_protected/workspaces/$workspaceId",
    select: (ctx) => ctx.user.activeOrganizationId,
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

export const justificationsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: workspaceKeys.justifications(workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .justifications.get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
