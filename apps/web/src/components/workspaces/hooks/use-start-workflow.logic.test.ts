import { describe, expect, test } from "bun:test";

import { APIError, toAPIError } from "@/lib/errors/api";
import { workflowTargetCountOptions } from "@/lib/workspaces/queries/workspace";

import {
  estimateWorkflowTargetCount,
  LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD,
  performWorkflowStart,
  resolveWorkflowStartDecision,
  resolveWorkflowServiceTier,
  WORKFLOW_START_FAILED,
} from "./use-start-workflow.logic";
import type { WorkflowTargetCountQueryClient } from "./use-start-workflow.logic";

type WorkflowTargetCountOptions = Parameters<
  WorkflowTargetCountQueryClient["query"]
>[0];

const createWorkflowTargetCountClient = (count: number) => {
  const queryCalls: WorkflowTargetCountOptions[] = [];
  const queryClient: WorkflowTargetCountQueryClient = {
    query: async (options) => {
      queryCalls.push(options);
      return count;
    },
  };

  return { queryCalls, queryClient };
};

describe("workflow start decision", () => {
  test("starts small workflows without prompting", async () => {
    const promptCounts: number[] = [];

    const decision = await resolveWorkflowStartDecision({
      confirmLargeRun: async ({ entityCount }) => {
        promptCounts.push(entityCount);
        return false;
      },
      estimateEntityCount: async () =>
        LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD - 1,
    });

    expect(decision).toEqual({ type: "start" });
    expect(promptCounts).toEqual([]);
  });

  test("prompts large workflows using the estimated entity count", async () => {
    const promptCounts: number[] = [];

    const decision = await resolveWorkflowStartDecision({
      confirmLargeRun: async ({ entityCount }) => {
        promptCounts.push(entityCount);
        return true;
      },
      estimateEntityCount: async () => LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD,
    });

    expect(decision).toEqual({ type: "start" });
    expect(promptCounts).toEqual([LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD]);
  });

  test("cancels a large workflow when the user dismisses or cancels", async () => {
    const decision = await resolveWorkflowStartDecision({
      confirmLargeRun: async () => false,
      estimateEntityCount: async () => 1000,
    });

    expect(decision).toEqual({ type: "cancel" });
  });

  test("cancels workflows when the entity count cannot be loaded", async () => {
    const decision = await resolveWorkflowStartDecision({
      confirmLargeRun: async () => true,
      estimateEntityCount: async () => null,
    });

    expect(decision).toEqual({ type: "cancel" });
  });

  test("loads the backend target count for scoped entity ids", async () => {
    const { queryCalls, queryClient } = createWorkflowTargetCountClient(1);
    const options = workflowTargetCountOptions({
      entityIds: ["entity-folder", "entity-document"],
      workspaceId: "workspace-a",
    });

    const count = await estimateWorkflowTargetCount({
      args: { entityIds: ["entity-folder", "entity-document"] },
      queryClient,
      workspaceId: "workspace-a",
    });

    expect(count).toBe(1);
    expect(queryCalls.map((call) => call.queryKey)).toEqual([options.queryKey]);
  });

  test("loads the full-workspace target count when scoped entity ids are empty", async () => {
    const { queryCalls, queryClient } = createWorkflowTargetCountClient(128);
    const options = workflowTargetCountOptions({
      entityIds: [],
      workspaceId: "workspace-a",
    });

    const count = await estimateWorkflowTargetCount({
      args: { entityIds: [] },
      queryClient,
      workspaceId: "workspace-a",
    });

    expect(count).toBe(128);
    expect(queryCalls.map((call) => call.queryKey)).toEqual([options.queryKey]);
  });

  test("propagates target count load failures", async () => {
    const expectedError = new Error("target count failed");
    const queryClient: WorkflowTargetCountQueryClient = {
      query: async () => {
        throw expectedError;
      },
    };

    await estimateWorkflowTargetCount({
      args: undefined,
      queryClient,
      workspaceId: "workspace-a",
    }).then(
      () => {
        throw new Error("Expected target count failure");
      },
      (error: unknown) => {
        expect(error).toBe(expectedError);
      },
    );
  });

  test("uses standard tier for small workflows", async () => {
    const promptCounts: number[] = [];

    const serviceTier = await resolveWorkflowServiceTier({
      args: undefined,
      deferredServiceTierAvailable: true,
      entityCount: LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD - 1,
      promptForServiceTier: async ({ entityCount }) => {
        promptCounts.push(entityCount);
        return "flex";
      },
    });

    expect(serviceTier).toBe("standard");
    expect(promptCounts).toEqual([]);
  });

  test("does not offer reduced credits when the provider cannot honor them", async () => {
    const promptCounts: number[] = [];

    const serviceTier = await resolveWorkflowServiceTier({
      args: undefined,
      deferredServiceTierAvailable: false,
      entityCount: LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD,
      promptForServiceTier: async ({ entityCount }) => {
        promptCounts.push(entityCount);
        return "flex";
      },
    });

    expect(serviceTier).toBe("standard");
    expect(promptCounts).toEqual([]);
  });

  test("prompts for large workflows when reduced credits are supported", async () => {
    const serviceTier = await resolveWorkflowServiceTier({
      args: undefined,
      deferredServiceTierAvailable: true,
      entityCount: LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD,
      promptForServiceTier: async () => "flex",
    });

    expect(serviceTier).toBe("flex");
  });

  test("honors an explicit service tier without prompting", async () => {
    const serviceTier = await resolveWorkflowServiceTier({
      args: { serviceTier: "flex" },
      deferredServiceTierAvailable: false,
      entityCount: LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD,
      promptForServiceTier: async () => {
        throw new Error("Unexpected service tier prompt");
      },
    });

    expect(serviceTier).toBe("flex");
  });
});

/** Records what the hook would show and capture for one start attempt. */
const createWorkflowStartSurface = () => {
  const captured: unknown[] = [];
  const counts = { notified: 0, queued: 0 };

  return {
    captured,
    counts,
    ports: {
      captureError: (error: unknown) => {
        captured.push(error);
      },
      notifyFailure: () => {
        counts.notified += 1;
      },
      onQueued: async () => {
        counts.queued += 1;
        await Promise.resolve();
      },
    },
  };
};

describe("performing a workflow start", () => {
  test("reports a rejected request instead of answering the caller with it", async () => {
    const { captured, counts, ports } = createWorkflowStartSurface();
    const requestError = new TypeError("Failed to fetch");

    const result = await performWorkflowStart({
      ...ports,
      request: async () => {
        throw requestError;
      },
    });

    // Every call site but the column re-run drops this answer, so a failure
    // only the return value carries is a workflow that silently never ran.
    expect(result).toBe(WORKFLOW_START_FAILED);
    expect(captured).toEqual([requestError]);
    expect(counts).toEqual({ notified: 1, queued: 0 });
  });

  test("reports an error status and hands the typed error to telemetry", async () => {
    const { captured, counts, ports } = createWorkflowStartSurface();

    const result = await performWorkflowStart({
      ...ports,
      // What `unwrapEden` throws for the endpoint's failed-enqueue answer.
      request: async () => {
        throw toAPIError({
          status: 500,
          value: { message: "Failed to start the workflow" },
        });
      },
    });

    expect(result).toBe(WORKFLOW_START_FAILED);
    expect(counts).toEqual({ notified: 1, queued: 0 });
    const [capturedError] = captured;
    if (!APIError.is(capturedError)) {
      throw new Error("Expected the response error to reach telemetry typed");
    }
    expect(capturedError.status).toBe(500);
  });

  test("passes a reported status through once the workflow cache is refreshed", async () => {
    const { captured, counts, ports } = createWorkflowStartSurface();

    const result = await performWorkflowStart({
      ...ports,
      request: async () => ({ status: "already-running" as const }),
    });

    // A run already holds the workspace: nothing failed, so the caller gets
    // the status and no failure is reported for it.
    expect(result).toEqual({ status: "already-running" });
    expect(counts).toEqual({ notified: 0, queued: 1 });
    expect(captured).toEqual([]);
  });
});
