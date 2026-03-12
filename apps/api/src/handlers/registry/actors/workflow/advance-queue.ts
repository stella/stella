import { panic, Result } from "better-result";
import type { ActionContextOf } from "rivetkit";

import type { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";
import { workflowActions } from "@/api/handlers/registry/actors/workflow/schema";
import type { WorkflowActionSchemas } from "@/api/handlers/registry/actors/workflow/schema";
import { runWorkflowAction } from "@/api/handlers/registry/actors/workflow/utils";

const MAX_PARALLEL = 10;

const { processBatch, finishWorkflow, advanceQueue } = workflowActions;

export const advanceQueueAction = async (
  c: ActionContextOf<typeof workflowActor>,
  { entityId, batchId }: WorkflowActionSchemas[typeof advanceQueue],
) =>
  await Result.tryPromise(async () => {
    const pendingEntity = c.state.pendingBatches.get(entityId);

    // If entity was running remove completed batch
    if (pendingEntity) {
      pendingEntity.remainingBatches.delete(batchId);

      // Still waiting for other batches at this level to complete
      if (pendingEntity.remainingBatches.size > 0) {
        return;
      }

      const nextLevel = pendingEntity.level + 1;

      if (nextLevel < c.state.executionPlan.length) {
        // Advance to next level
        await processNextBatches(c, entityId, nextLevel);
        return;
      }

      // Entity fully processed
      c.state.pendingBatches.delete(entityId);
    }

    // Check if workflow is complete
    if (
      c.state.isRunning &&
      c.state.queuedEntities.size === 0 &&
      c.state.pendingBatches.size === 0
    ) {
      await runWorkflowAction(c, finishWorkflow);
      return;
    }

    // Fill up to MAX_PARALLEL with new entities
    for (const nextEntityId of c.state.queuedEntities) {
      if (c.state.pendingBatches.size >= MAX_PARALLEL) {
        break;
      }

      c.state.queuedEntities.delete(nextEntityId);

      await processNextBatches(c, nextEntityId, 0);
    }
  });

const processNextBatches = async (
  c: ActionContextOf<typeof workflowActor>,
  entityId: string,
  level: number,
) => {
  const batches = c.state.executionPlan.at(level);

  if (!batches || batches.length === 0) {
    panic(`No batches at level ${level}`);
  }

  const remainingBatches = await Promise.all(
    batches.map(async (batch) => {
      await runWorkflowAction(c, processBatch, {
        batchId: batch.id,
        level,
        entityId,
      });

      return batch.id;
    }),
  );

  c.state.pendingBatches.set(entityId, {
    level,
    remainingBatches: new Set(remainingBatches),
  });
};
