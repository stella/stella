import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { entitySummariesCountOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

import {
  estimateWorkflowEntityCount,
  LARGE_WORKFLOW_ENTITY_PROMPT_THRESHOLD,
  resolveWorkflowStartDecision,
} from "./use-start-workflow.logic";

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

  test("counts scoped entity ids without loading workspace summaries", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const count = await estimateWorkflowEntityCount({
      args: { entityIds: ["entity-a", "entity-b"] },
      queryClient,
      workspaceId: "workspace-a",
    });

    expect(count).toBe(2);
  });

  test("loads workspace summaries when scoped entity ids are empty", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = entitySummariesCountOptions("workspace-a");
    queryClient.setQueryData(options.queryKey, 128);

    const count = await estimateWorkflowEntityCount({
      args: { entityIds: [] },
      queryClient,
      workspaceId: "workspace-a",
    });

    expect(count).toBe(128);
  });
});
