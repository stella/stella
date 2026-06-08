import { matchError, Result } from "better-result";

import type {
  WorkflowIntegrationError,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import type { AIRequestServiceTier } from "@/api/lib/ai-models";
import type { ExecutionLevel } from "@/api/lib/workflow/get-execution-plan";

export const STANDARD_WORKFLOW_BATCH_AI_TIMEOUT_MS = 120 * 1000;
export const DEFERRED_WORKFLOW_BATCH_AI_TIMEOUT_MS = 16 * 60 * 1000;
export const WORKFLOW_INTEGRATION_ERROR_RETRY_DELAY_MS = 5 * 1000;
export const WORKFLOW_INTEGRATION_ERROR_ATTEMPTS = 2;

const JOB_TIMEOUT_FLOOR_MS = 6 * 60 * 1000;
const JOB_TIMEOUT_PER_LEVEL_OVERHEAD_MS = 60 * 1000;

type WorkflowBatchError = WorkflowIntegrationError | WorkflowValidationError;

type WorkflowBatchGenerationResult<TValue> = Result<TValue, WorkflowBatchError>;

const isDeferredWorkflowServiceTier = (
  serviceTier: AIRequestServiceTier,
): boolean => serviceTier === "flex" || serviceTier === "batch";

export const getWorkflowBatchAITimeoutMs = (
  serviceTier: AIRequestServiceTier,
): number =>
  isDeferredWorkflowServiceTier(serviceTier)
    ? DEFERRED_WORKFLOW_BATCH_AI_TIMEOUT_MS
    : STANDARD_WORKFLOW_BATCH_AI_TIMEOUT_MS;

type ShouldRetryWorkflowBatchErrorArgs = {
  attempt: number;
  error: WorkflowBatchError;
  maxAttempts?: number;
};

export const computeWorkflowJobTimeoutMs = (
  executionPlan: ExecutionLevel[],
  serviceTier: AIRequestServiceTier,
): number => {
  const levels = executionPlan.length;
  const batchTimeoutMs = getWorkflowBatchAITimeoutMs(serviceTier);
  const retryDelayMs =
    WORKFLOW_INTEGRATION_ERROR_RETRY_DELAY_MS *
    Math.max(0, WORKFLOW_INTEGRATION_ERROR_ATTEMPTS - 1);
  const perLevelTimeoutMs =
    batchTimeoutMs * WORKFLOW_INTEGRATION_ERROR_ATTEMPTS +
    retryDelayMs +
    JOB_TIMEOUT_PER_LEVEL_OVERHEAD_MS;
  return Math.max(
    JOB_TIMEOUT_FLOOR_MS,
    levels * perLevelTimeoutMs + JOB_TIMEOUT_FLOOR_MS,
  );
};

export const shouldRetryWorkflowBatchError = ({
  attempt,
  error,
  maxAttempts = WORKFLOW_INTEGRATION_ERROR_ATTEMPTS,
}: ShouldRetryWorkflowBatchErrorArgs): boolean => {
  if (attempt >= maxAttempts) {
    return false;
  }

  return matchError(error, {
    WorkflowIntegrationError: () => true,
    WorkflowValidationError: () => false,
  });
};

type RunWorkflowBatchGenerationWithRetryArgs<TValue> = {
  generate: () => Promise<WorkflowBatchGenerationResult<TValue>>;
  onRetryError: (error: WorkflowBatchError, attempt: number) => void;
  sleep: (milliseconds: number) => Promise<void>;
  throwIfAborted: () => void;
};

export const runWorkflowBatchGenerationWithRetry = async <TValue>({
  generate,
  onRetryError,
  sleep,
  throwIfAborted,
}: RunWorkflowBatchGenerationWithRetryArgs<TValue>): Promise<
  WorkflowBatchGenerationResult<TValue>
> => {
  let attempt = 1;

  while (true) {
    const batchResult = await generate();

    if (!Result.isError(batchResult)) {
      return batchResult;
    }

    if (
      !shouldRetryWorkflowBatchError({
        attempt,
        error: batchResult.error,
      })
    ) {
      return batchResult;
    }

    onRetryError(batchResult.error, attempt);
    throwIfAborted();
    await sleep(WORKFLOW_INTEGRATION_ERROR_RETRY_DELAY_MS);
    throwIfAborted();
    attempt++;
  }
};
