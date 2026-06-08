import { describe, expect, test } from "bun:test";

import { workflowTargetCountOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

import {
  estimateWorkflowTargetCount,
  LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD,
  resolveWorkflowStartDecision,
  resolveWorkflowServiceTier,
} from "./use-start-workflow.logic";
import type { WorkflowTargetCountQueryClient } from "./use-start-workflow.logic";

type WorkflowTargetCountOptions = Parameters<
  WorkflowTargetCountQueryClient["fetchQuery"]
>[0];

const createWorkflowTargetCountClient = (count: number) => {
  const fetchQueryCalls: WorkflowTargetCountOptions[] = [];
  const queryClient: WorkflowTargetCountQueryClient = {
    fetchQuery: async (options) => {
      fetchQueryCalls.push(options);
      return count;
    },
  };

  return { fetchQueryCalls, queryClient };
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
    const { fetchQueryCalls, queryClient } = createWorkflowTargetCountClient(1);
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
    expect(fetchQueryCalls.map((call) => call.queryKey)).toEqual([
      options.queryKey,
    ]);
  });

  test("loads the full-workspace target count when scoped entity ids are empty", async () => {
    const { fetchQueryCalls, queryClient } =
      createWorkflowTargetCountClient(128);
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
    expect(fetchQueryCalls.map((call) => call.queryKey)).toEqual([
      options.queryKey,
    ]);
  });

  test("propagates target count load failures", async () => {
    const expectedError = new Error("target count failed");
    const queryClient: WorkflowTargetCountQueryClient = {
      fetchQuery: async () => {
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
