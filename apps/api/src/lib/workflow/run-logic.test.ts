import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  WorkflowIntegrationError,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import {
  computeWorkflowJobTimeoutMs,
  runWorkflowBatchGenerationWithRetry,
  WORKFLOW_BATCH_AI_TIMEOUT_MS,
  WORKFLOW_INTEGRATION_ERROR_RETRY_DELAY_MS,
} from "@/api/lib/workflow/run-logic";

describe("workflow batch retry", () => {
  test("retries a transient integration failure and returns the later success", async () => {
    const retryErrors: string[] = [];
    const sleepDelays: number[] = [];
    let attempts = 0;

    const result = await runWorkflowBatchGenerationWithRetry({
      generate: async () => {
        attempts++;
        if (attempts === 1) {
          return Result.err(
            new WorkflowIntegrationError({
              message: "temporary provider failure",
            }),
          );
        }

        return Result.ok("processed");
      },
      onRetryError: (error) => {
        retryErrors.push(error.message);
      },
      sleep: async (milliseconds) => {
        sleepDelays.push(milliseconds);
      },
      throwIfAborted: () => {},
    });

    expect(Result.isError(result)).toBe(false);
    if (Result.isError(result)) {
      return;
    }

    expect(result.value).toBe("processed");
    expect(attempts).toBe(2);
    expect(retryErrors).toEqual(["temporary provider failure"]);
    expect(sleepDelays).toEqual([WORKFLOW_INTEGRATION_ERROR_RETRY_DELAY_MS]);
  });

  test("does not retry a workflow validation failure", async () => {
    const retryErrors: string[] = [];
    let attempts = 0;

    const result = await runWorkflowBatchGenerationWithRetry({
      generate: async () => {
        attempts++;
        return Result.err(
          new WorkflowValidationError({
            message: "AI output did not match the property schema",
          }),
        );
      },
      onRetryError: (error) => {
        retryErrors.push(error.message);
      },
      sleep: async () => {},
      throwIfAborted: () => {},
    });

    expect(Result.isError(result)).toBe(true);
    expect(attempts).toBe(1);
    expect(retryErrors).toEqual([]);
  });

  test("returns the final integration error after the retry budget is exhausted", async () => {
    const retryErrors: string[] = [];
    let attempts = 0;

    const result = await runWorkflowBatchGenerationWithRetry({
      generate: async () => {
        attempts++;
        return Result.err(
          new WorkflowIntegrationError({
            message: `provider failure ${attempts}`,
          }),
        );
      },
      onRetryError: (error) => {
        retryErrors.push(error.message);
      },
      sleep: async () => {},
      throwIfAborted: () => {},
    });

    expect(Result.isError(result)).toBe(true);
    if (!Result.isError(result)) {
      return;
    }

    expect(result.error.message).toBe("provider failure 2");
    expect(attempts).toBe(2);
    expect(retryErrors).toEqual(["provider failure 1"]);
  });
});

describe("workflow timeout budget", () => {
  test("scales entity job timeout above the per-batch timeout and retry budget", () => {
    expect(computeWorkflowJobTimeoutMs([[]])).toBeGreaterThan(
      WORKFLOW_BATCH_AI_TIMEOUT_MS * 2,
    );
  });
});
