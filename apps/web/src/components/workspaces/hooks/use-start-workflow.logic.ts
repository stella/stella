import { Result } from "better-result";

import { workflowTargetCountOptions } from "@/lib/workspaces/queries/workspace";

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
  query: (
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

  return await queryClient.query(
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

/**
 * Answered when the request never reached the queue. The failure is reported
 * where it happens, because most call sites start a workflow as a side effect
 * of another action and drop this answer; a caller that does read it must not
 * treat it as a running workflow.
 */
export const WORKFLOW_START_FAILED = { status: "failed" } as const;

/**
 * Answered when the organization has no usable AI configuration, so no request
 * was sent. Distinct from a failure: the workspace surface already prompts for
 * a key, and the side-effect call sites fire on edits that may have nothing to
 * extract, where a toast per edit would be noise.
 */
export const WORKFLOW_START_AI_UNAVAILABLE = {
  status: "ai-unavailable",
} as const;

type PerformWorkflowStartArgs<TStatus extends string> = {
  captureError: (error: unknown) => void;
  notifyFailure: () => void;
  onQueued: () => Promise<void>;
  /** Sends the request and unwraps it, so an error response throws. */
  request: () => Promise<{ status: TStatus }>;
};

type PerformWorkflowStartResult<TStatus extends string> =
  | { status: TStatus }
  | typeof WORKFLOW_START_FAILED;

/**
 * Send the start request and answer only a status the endpoint stands behind.
 * A request that never reached the queue, whether it failed in transport or
 * came back an error status, ends in telemetry and in front of the user here
 * rather than in a return value the caller drops.
 */
export const performWorkflowStart = async <TStatus extends string>({
  captureError,
  notifyFailure,
  onQueued,
  request,
}: PerformWorkflowStartArgs<TStatus>): Promise<
  PerformWorkflowStartResult<TStatus>
> => {
  // Keep the thrown value itself rather than the wrapper `tryPromise` would
  // otherwise build, so telemetry receives the original error.
  const attempt = await Result.tryPromise({
    try: request,
    catch: (cause) => cause,
  });
  if (attempt.isErr()) {
    captureError(attempt.error);
    notifyFailure();
    return WORKFLOW_START_FAILED;
  }

  await onQueued();
  return attempt.value;
};
