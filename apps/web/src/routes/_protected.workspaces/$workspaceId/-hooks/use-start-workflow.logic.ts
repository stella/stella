import type { QueryClient } from "@tanstack/react-query";

import { workflowTargetCountOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

export type StartWorkflowArgs = {
  entityIds?: string[];
  entityIdsOrder?: string[];
  propertyIds?: string[];
};

export type WorkflowStartDecision = { type: "start" } | { type: "cancel" };

export const LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD = 50;

type ResolveWorkflowStartDecisionArgs = {
  confirmLargeRun: (input: { entityCount: number }) => Promise<boolean>;
  estimateEntityCount: () => Promise<number | null>;
};

export const resolveWorkflowStartDecision = async ({
  confirmLargeRun,
  estimateEntityCount,
}: ResolveWorkflowStartDecisionArgs): Promise<WorkflowStartDecision> => {
  const entityCount = await estimateEntityCount();
  if (entityCount === null) {
    return { type: "cancel" };
  }

  if (entityCount < LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD) {
    return { type: "start" };
  }

  const confirmed = await confirmLargeRun({ entityCount });
  if (!confirmed) {
    return { type: "cancel" };
  }

  return { type: "start" };
};

type EstimateWorkflowTargetCountArgs = {
  args: StartWorkflowArgs | undefined;
  queryClient: QueryClient;
  workspaceId: string;
};

export const estimateWorkflowTargetCount = async ({
  args,
  queryClient,
  workspaceId,
}: EstimateWorkflowTargetCountArgs): Promise<number | null> => {
  const entityIds = args?.entityIds === undefined ? [] : [...args.entityIds];

  try {
    return await queryClient.ensureQueryData(
      workflowTargetCountOptions({
        entityIds,
        workspaceId,
      }),
    );
  } catch {
    return null;
  }
};
