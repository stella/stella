import { matchError, Result } from "better-result";

import type { AIErrorKind } from "@stll/api-contract";
import { backoffDelay } from "@stll/concurrency/backoff-delay";

import type { AIRequestServiceTier } from "@/api/lib/ai-config";
import { classifyAIError, providerStatusCode } from "@/api/lib/ai-error";
import type {
  DocumentTooLargeError,
  WorkflowIntegrationError,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import type { ExecutionLevel } from "@/api/lib/workflow/get-execution-plan";

const STANDARD_WORKFLOW_BATCH_AI_TIMEOUT_MS = 120 * 1000;
const DEFERRED_WORKFLOW_BATCH_AI_TIMEOUT_MS = 16 * 60 * 1000;
export const WORKFLOW_INTEGRATION_ERROR_RETRY_DELAY_MS = 5 * 1000;
const WORKFLOW_INTEGRATION_ERROR_ATTEMPTS = 2;
export const WORKFLOW_ENTITY_JOB_ATTEMPTS = 2;
export const WORKFLOW_ENTITY_JOB_BACKOFF_DELAY_MS = 5 * 1000;

const JOB_TIMEOUT_FLOOR_MS = 6 * 60 * 1000;
const JOB_TIMEOUT_PER_LEVEL_OVERHEAD_MS = 60 * 1000;
const MIN_WORKFLOW_RUN_LOCK_TTL_SEC = 60 * 60;
const WORKFLOW_RUN_LOCK_TTL_BUFFER_MS = 5 * 60 * 1000;

type WorkflowBatchError =
  WorkflowIntegrationError | WorkflowValidationError | DocumentTooLargeError;

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

const computeWorkflowEntityJobBackoffMs = (): number => {
  let backoffMs = 0;
  for (
    let retryIndex = 0;
    retryIndex < WORKFLOW_ENTITY_JOB_ATTEMPTS - 1;
    retryIndex++
  ) {
    backoffMs += backoffDelay(retryIndex, {
      baseMs: WORKFLOW_ENTITY_JOB_BACKOFF_DELAY_MS,
    });
  }
  return backoffMs;
};

export const computeWorkflowRunLockTtlSec = (
  executionPlan: ExecutionLevel[],
  serviceTier: AIRequestServiceTier,
): number => {
  const minimumLockTtlMs = MIN_WORKFLOW_RUN_LOCK_TTL_SEC * 1000;
  const jobTimeoutMs = computeWorkflowJobTimeoutMs(executionPlan, serviceTier);
  const entityJobBudgetMs =
    jobTimeoutMs * WORKFLOW_ENTITY_JOB_ATTEMPTS +
    computeWorkflowEntityJobBackoffMs();
  return Math.ceil(
    Math.max(
      minimumLockTtlMs,
      entityJobBudgetMs + WORKFLOW_RUN_LOCK_TTL_BUFFER_MS,
    ) / 1000,
  );
};

// Whether the same request could succeed a moment later. A retry resends every
// document in the batch, so it is wasted on a failure only a person can fix.
const AI_FAILURE_CAN_CLEAR_ON_RETRY = {
  quota_exhausted: true,
  provider_billing: false,
  provider_credentials_rejected: false,
  model_unavailable: false,
  provider_unavailable: true,
  provider_stream_incomplete: true,
  output_incomplete: true,
  output_moderated: true,
  output_invalid: true,
  deadline_exceeded: true,
  loop_detected: true,
  empty_completion: true,
  local_runner_needs_login: false,
  local_runner_limit_reached: false,
  local_runner_unavailable: true,
  local_runner_turn_too_large: false,
  local_runner_not_reached: true,
  local_runner_relinked: true,
  local_runner_restoring: true,
  local_runner_folder_unavailable: false,
  unknown: true,
} as const satisfies Record<AIErrorKind, boolean>;

// The provider refused this request as built, for example because it overflows
// the model's context window. No failure kind names these.
const REJECTED_REQUEST_STATUSES: ReadonlySet<number> = new Set([400, 413]);

const canClearOnRetry = (error: WorkflowIntegrationError): boolean => {
  const status = providerStatusCode(error);
  if (status !== null && REJECTED_REQUEST_STATUSES.has(status)) {
    return false;
  }
  return AI_FAILURE_CAN_CLEAR_ON_RETRY[classifyAIError(error)];
};

const shouldRetryWorkflowBatchError = ({
  attempt,
  error,
  maxAttempts = WORKFLOW_INTEGRATION_ERROR_ATTEMPTS,
}: ShouldRetryWorkflowBatchErrorArgs): boolean => {
  if (attempt >= maxAttempts) {
    return false;
  }

  return matchError(error, {
    WorkflowIntegrationError: canClearOnRetry,
    WorkflowValidationError: () => false,
    DocumentTooLargeError: () => false,
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
