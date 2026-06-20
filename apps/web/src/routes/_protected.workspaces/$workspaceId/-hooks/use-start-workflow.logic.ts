import { workflowTargetCountOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

export type StartWorkflowArgs = {
  entityIds?: string[];
  entityIdsOrder?: string[];
  propertyIds?: string[];
  serviceTier?: WorkflowServiceTier;
};

export type WorkflowServiceTier = "standard" | "flex";
export type WorkflowStartDecision = { type: "start" } | { type: "cancel" };

export const LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD = 50;

export type WorkflowTargetCountQueryClient = {
  fetchQuery: (
    options: ReturnType<typeof workflowTargetCountOptions>,
  ) => Promise<number>;
};

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
  queryClient: WorkflowTargetCountQueryClient;
  workspaceId: string;
};

export const estimateWorkflowTargetCount = async ({
  args,
  queryClient,
  workspaceId,
}: EstimateWorkflowTargetCountArgs): Promise<number> => {
  const entityIds = args?.entityIds === undefined ? [] : [...args.entityIds];

  return await queryClient.fetchQuery(
    workflowTargetCountOptions({
      entityIds,
      workspaceId,
    }),
  );
};

type ResolveWorkflowServiceTierArgs = {
  args: StartWorkflowArgs | undefined;
  deferredServiceTierAvailable: boolean;
  promptForServiceTier: (input: {
    entityCount: number;
  }) => Promise<WorkflowServiceTier>;
  entityCount: number;
};

export const resolveWorkflowServiceTier = async ({
  args,
  deferredServiceTierAvailable,
  promptForServiceTier,
  entityCount,
}: ResolveWorkflowServiceTierArgs): Promise<WorkflowServiceTier> => {
  if (args?.serviceTier !== undefined) {
    return args.serviceTier;
  }

  if (
    !deferredServiceTierAvailable ||
    entityCount < LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD
  ) {
    return "standard";
  }

  return await promptForServiceTier({ entityCount });
};
