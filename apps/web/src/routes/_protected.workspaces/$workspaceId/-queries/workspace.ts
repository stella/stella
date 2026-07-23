import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceJustification } from "@/lib/types";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type JustificationsKey = {
  workspaceId: string;
  entityIds: string[];
};

type WorkflowTargetCountKey = {
  workspaceId: string;
  entityIds: string[];
};

export const workspaceKeys = {
  workflow: (workspaceId: string) => [
    ...workspacesKeys.byId(workspaceId),
    "workflow",
  ],
  workflowTargetCount: ({ entityIds, workspaceId }: WorkflowTargetCountKey) => [
    ...workspaceKeys.workflow(workspaceId),
    "target-count",
    { entityIds },
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
type WorkflowTargetCountOptionsInput =
  QueryOptionsInput<WorkflowTargetCountKey>;

const WORKFLOW_STATUS_POLL_INTERVAL_MS = 2000;

export const workflowOptions = ({ key }: { key: WorkflowKey }) =>
  queryOptions({
    queryKey: workspaceKeys.workflow(key.workspaceId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        .workflow.get({ fetch: { signal } });

      return unwrapEden(response);
    },
  });

type RawWorkspaceJustification = Omit<
  WorkspaceJustification,
  "id" | "fieldId" | "fileFieldIds"
> & {
  id: string;
  fieldId: string;
  fileFieldIds: string[];
};

const toWorkspaceJustification = (
  justification: RawWorkspaceJustification,
): WorkspaceJustification => ({
  ...justification,
  id: toSafeId<"justification">(justification.id),
  fieldId: toSafeId<"field">(justification.fieldId),
  fileFieldIds: justification.fileFieldIds.map((fieldId) =>
    toSafeId<"field">(fieldId),
  ),
});

export const workflowTargetCountOptions = ({
  entityIds,
  workspaceId,
}: WorkflowTargetCountOptionsInput) =>
  queryOptions({
    queryKey: workspaceKeys.workflowTargetCount({ entityIds, workspaceId }),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .workflow["target-count"].post(
          {
            ...(entityIds.length > 0 && {
              entityIds: entityIds.map((id) => toSafeId<"entity">(id)),
            }),
          },
          { fetch: { signal } },
        );

      return unwrapEden(response).count;
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

export const useWorkflowStatus = (workspaceId: string) =>
  useQuery({
    ...workflowOptions({ key: { workspaceId } }),
    refetchInterval: (query) =>
      query.state.data?.running ? WORKFLOW_STATUS_POLL_INTERVAL_MS : false,
  });

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

      return unwrapEden(response).map(toWorkspaceJustification);
    },
  });
