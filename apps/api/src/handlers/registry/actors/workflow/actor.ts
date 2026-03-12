import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { actor, UserError } from "rivetkit";

import { entities } from "@/api/db/schema";
import { advanceQueueAction } from "@/api/handlers/registry/actors/workflow/advance-queue";
import { finishWorkflowAction } from "@/api/handlers/registry/actors/workflow/finish-workflow";
import {
  getExecutionPlanData,
  getPropertyExecutionPlan,
} from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import { processBatchAction } from "@/api/handlers/registry/actors/workflow/process-batch";
import {
  defaultWorkflowState,
  startWorkflowSchema,
  workflowActions,
} from "@/api/handlers/registry/actors/workflow/schema";
import type {
  StartWorkflowReturn,
  StartWorkflowSchema,
  WorkflowActionSchemas,
} from "@/api/handlers/registry/actors/workflow/schema";
import {
  handleUnrecoverableError,
  runWorkflowAction,
} from "@/api/handlers/registry/actors/workflow/utils";
import {
  broadcastEvent,
  createUserError,
  validateActorInput,
  validateActorSession,
} from "@/api/handlers/registry/utils";

const { processBatch, advanceQueue, finishWorkflow } = workflowActions;

type DestroyActionResult =
  | {
      success: true;
    }
  | {
      success: false;
      message: string;
    };

export const workflowActor = actor({
  state: defaultWorkflowState(),
  createConnState: async (c, params) =>
    await validateActorSession(c.key, params),
  onWake: (c) => {
    if (!c.state.isRunning) {
      return;
    }

    if (c.state.pendingBatches.size === 0) {
      c.state.isRunning = false;
      return;
    }

    for (const [entityId, pendingEntity] of c.state.pendingBatches) {
      for (const batchId of pendingEntity.remainingBatches) {
        // eslint-disable-next-line typescript/no-floating-promises
        runWorkflowAction(c, processBatch, {
          batchId,
          level: pendingEntity.level,
          entityId,
        });
      }
    }
  },
  actions: {
    getWorkflowStatus: (c) => ({ running: c.state.isRunning }),
    startWorkflow: async (
      c,
      rawInput: StartWorkflowSchema,
    ): Promise<StartWorkflowReturn> => {
      const input = validateActorInput(startWorkflowSchema, rawInput);
      const { workspaceId, scopedDb } = c.conn.state;
      if (c.state.isRunning) {
        c.log.warn("Workflow already running");
        return { status: "already-running" };
      }

      c.state.requestId = nanoid();
      c.state.isRunning = true;
      broadcastEvent(c, {
        name: "workflow-status",
        data: { running: true },
      });

      const nestedResult = await Result.tryPromise(async () => {
        const entityRows = await scopedDb((tx) =>
          tx
            .select({ id: entities.id, kind: entities.kind })
            .from(entities)
            .where(eq(entities.workspaceId, workspaceId)),
        );

        const executionPlanData = await getExecutionPlanData(
          workspaceId,
          scopedDb,
        );
        const executionPlan = getPropertyExecutionPlan(executionPlanData);

        c.state.executionPlan = executionPlan;

        // Filter out folders (they can't have AI-derived metadata)
        const nonFolderIds = new Set(
          entityRows.filter((e) => e.kind !== "folder").map((e) => e.id),
        );

        const inputEntityIds = input.entityIds ?? [];
        const inputOrder = input.entityIdsOrder ?? [];

        // Determine target entities: restrict to entityIds if
        // provided, otherwise process all non-folder entities
        const targetIds =
          inputEntityIds.length > 0
            ? inputEntityIds.filter((id) => nonFolderIds.has(id))
            : [...nonFolderIds];

        // Prioritize entities from entityIdsOrder first,
        // then remaining in default order
        const targetSet = new Set(targetIds);
        const prioritized = inputOrder.filter((id) => targetSet.has(id));
        const prioritizedSet = new Set(prioritized);
        const remaining = targetIds.filter((id) => !prioritizedSet.has(id));
        const orderedEntityIds = [...prioritized, ...remaining];

        for (const entityId of orderedEntityIds) {
          c.state.queuedEntities.add(entityId);
        }

        const batchId = executionPlan.at(0)?.at(0)?.id;
        const entityId = orderedEntityIds.at(0);

        // No AI properties to process: finish immediately
        if (!batchId || !entityId) {
          c.log.debug(
            { requestId: c.state.requestId },
            "Empty execution plan, finishing",
          );
          await runWorkflowAction(c, finishWorkflow);
          return Result.ok();
        }

        c.log.debug({ requestId: c.state.requestId }, "Starting workflow");

        await runWorkflowAction(c, advanceQueue, {
          batchId,
          entityId,
        });

        return Result.ok();
      });

      const workflowStartResult = Result.flatten(nestedResult);

      if (Result.isOk(workflowStartResult)) {
        return { status: "started" };
      }

      const error = workflowStartResult.error;

      handleUnrecoverableError({
        c,
        requestId: c.state.requestId,
        error,
      });

      c.state.isRunning = false;
      broadcastEvent(c, {
        name: "workflow-status",
        data: { running: false },
      });

      if (workflowStartResult.error instanceof UserError) {
        throw workflowStartResult.error;
      }

      return { status: "failed" };
    },
    [advanceQueue]: async (
      c,
      input: WorkflowActionSchemas[typeof advanceQueue],
    ) => {
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- c.conn connection check
      if (c.conn) {
        throw createUserError("forbidden");
      }

      c.log.debug(
        { requestId: c.state.requestId, ...input },
        "Advancing queue",
      );

      const result = await advanceQueueAction(c, input);

      if (Result.isError(result)) {
        handleUnrecoverableError({
          c,
          requestId: c.state.requestId,
          error: result.error,
        });
      }
    },
    [processBatch]: async (
      c,
      input: WorkflowActionSchemas[typeof processBatch],
    ) => {
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- c.conn connection check
      if (c.conn) {
        throw createUserError("forbidden");
      }

      c.log.debug(
        { requestId: c.state.requestId, ...input },
        "Processing batch",
      );

      const result = await processBatchAction(c, input);

      if (Result.isError(result)) {
        handleUnrecoverableError({
          c,
          requestId: c.state.requestId,
          error: result.error,
        });
      }
    },
    [finishWorkflow]: async (c) => {
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- c.conn connection check
      if (c.conn) {
        throw createUserError("forbidden");
      }

      c.log.debug({ requestId: c.state.requestId }, "Finishing workflow");

      const result = await finishWorkflowAction(c);

      if (Result.isError(result)) {
        handleUnrecoverableError({
          c,
          requestId: c.state.requestId,
          error: result.error,
        });
      }
    },
    destroy: (c): DestroyActionResult => {
      if (c.state.isRunning) {
        return {
          success: false,
          message: "You can't delete workspace while workflow is running",
        };
      }

      c.destroy();

      return { success: true };
    },
  },
});
