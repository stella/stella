import { nanoid } from "nanoid";
import * as v from "valibot";

import type { ExecutionLevel } from "@/api/handlers/registry/actors/workflow/get-execution-plan";

type PendingEntity = {
  level: number;
  remainingBatches: Set<string>;
};

type WorkflowState = {
  requestId: string;
  isRunning: boolean;
  executionPlan: ExecutionLevel[];
  queuedEntities: Set<string>;
  pendingBatches: Map<string, PendingEntity>;
};

export const defaultWorkflowState = (): WorkflowState => ({
  requestId: nanoid(),
  isRunning: false,
  executionPlan: [],
  queuedEntities: new Set(),
  pendingBatches: new Map(),
});

export const startWorkflowSchema = v.object({
  workspaceId: v.string(),
  entityIds: v.pipe(v.array(v.string()), v.nonEmpty()),
});

export type StartWorkflowSchema = v.InferOutput<typeof startWorkflowSchema>;

export type StartWorkflowReturn = {
  status: "started" | "already-running" | "failed";
};

const processBatchSchema = v.object({
  batchId: v.string(),
  level: v.number(),
  entityId: v.string(),
});

const advanceQueueSchema = v.object({
  batchId: v.string(),
  entityId: v.string(),
});

export const workflowActions = {
  processBatch: "_processBatch",
  advanceQueue: "_advanceQueue",
  finishWorkflow: "_finishWorkflow",
} as const;

export const workflowActionSchemas = {
  [workflowActions.processBatch]: processBatchSchema,
  [workflowActions.advanceQueue]: advanceQueueSchema,
  [workflowActions.finishWorkflow]: v.void_(),
} as const;

export type WorkflowActionSchemas = {
  [K in keyof typeof workflowActionSchemas]: v.InferOutput<
    (typeof workflowActionSchemas)[K]
  >;
};
