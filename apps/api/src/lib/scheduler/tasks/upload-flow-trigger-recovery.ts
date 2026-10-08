import { panic } from "better-result";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";

import {
  flowDefinitions,
  flowUploadTriggerIntents,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import type {
  StartAutomatedFlowRunArgs,
  StartAutomatedFlowRunOutcome,
} from "@/api/lib/flows/start-automated-flow-run";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const RECOVER_UPLOAD_FLOW_TRIGGERS_TASK =
  "flows.recoverUploadTriggers" as const;
const UPLOAD_TRIGGER_BATCH_SIZE = 32;
const UPLOAD_TRIGGER_RETRY_MS = 5 * 60_000;
// Step zero waits for the independently queued extraction to usually finish.
const FLOW_UPLOAD_TRIGGER_DELAY_MS = 30_000;

type UploadTriggerIntent = typeof flowUploadTriggerIntents.$inferSelect;
type UploadTriggerCandidate = {
  intent: UploadTriggerIntent;
  definition: Pick<typeof flowDefinitions.$inferSelect, "createdByUserId">;
  workspaceStatus: string;
};

type DispatchUploadFlowTriggerOptions = {
  candidate: UploadTriggerCandidate;
  start: (
    input: StartAutomatedFlowRunArgs,
  ) => Promise<StartAutomatedFlowRunOutcome>;
};

/** The run transaction rechecks the current trigger against the durable receipt. */
export const dispatchUploadFlowTrigger = async ({
  candidate: { intent, definition, workspaceStatus },
  start,
}: DispatchUploadFlowTriggerOptions): Promise<StartAutomatedFlowRunOutcome> => {
  if (workspaceStatus !== "active") {
    return { status: "paused" };
  }
  return await start({
    definitionId: intent.definitionId,
    organizationId: intent.organizationId,
    workspaceId: intent.workspaceId,
    createdByUserId: definition.createdByUserId,
    triggerSource: { type: "file-upload", entityId: intent.entityId },
    inputEntityIds: [intent.entityId],
    enqueueDelayMs: FLOW_UPLOAD_TRIGGER_DELAY_MS,
    logContext: {
      definitionId: intent.definitionId,
      workspaceId: intent.workspaceId,
      trigger: "file-upload",
    },
  });
};

type RecoverUploadFlowTriggerOptions = {
  database: SchedulerDb;
  now: Date;
  entityId?: SafeId<"entity">;
  signal?: AbortSignal;
  start?: DispatchUploadFlowTriggerOptions["start"];
};

/** Owner-level sweep; ordinary upload writes persist receipts through workspace RLS. */
export const recoverUploadFlowTriggerIntents = async ({
  database,
  now,
  entityId,
  signal,
  start,
}: RecoverUploadFlowTriggerOptions) => {
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return { settled: 0, paused: 0, retry: 0, skipped: 0 };
  }
  const candidates = await database.transaction(async (tx) => {
    const selected = await tx
      .select({
        intent: flowUploadTriggerIntents,
        definition: {
          createdByUserId: flowDefinitions.createdByUserId,
        },
        workspaceStatus: workspaces.status,
      })
      .from(flowUploadTriggerIntents)
      .innerJoin(
        flowDefinitions,
        and(
          eq(flowDefinitions.id, flowUploadTriggerIntents.definitionId),
          eq(
            flowDefinitions.organizationId,
            flowUploadTriggerIntents.organizationId,
          ),
        ),
      )
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, flowUploadTriggerIntents.workspaceId),
          eq(
            workspaces.organizationId,
            flowUploadTriggerIntents.organizationId,
          ),
        ),
      )
      .where(
        and(
          eq(flowUploadTriggerIntents.status, "pending"),
          lte(flowUploadTriggerIntents.retryAt, sql`${now}::timestamptz`),
          entityId === undefined
            ? undefined
            : eq(flowUploadTriggerIntents.entityId, entityId),
        ),
      )
      .orderBy(
        asc(flowUploadTriggerIntents.retryAt),
        asc(flowUploadTriggerIntents.definitionId),
        asc(flowUploadTriggerIntents.entityId),
      )
      .limit(UPLOAD_TRIGGER_BATCH_SIZE)
      .for("update", { of: flowUploadTriggerIntents, skipLocked: true });
    if (selected.length === 0) {
      return [];
    }
    // audit: skip — claim derived dispatch receipts; run creation owns its audit trail.
    await tx
      .update(flowUploadTriggerIntents)
      .set({ retryAt: new Date(now.getTime() + UPLOAD_TRIGGER_RETRY_MS) })
      .where(
        or(
          ...selected.map(({ intent }) =>
            and(
              eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
              eq(flowUploadTriggerIntents.entityId, intent.entityId),
            ),
          ),
        ),
      );
    return selected;
  });
  const dependencies = automatedFlowRunDependencies(database);
  const outcomes = { settled: 0, paused: 0, retry: 0, skipped: 0 };
  for (const candidate of candidates) {
    if (signal?.aborted) {
      break;
    }
    const outcome = await dispatchUploadFlowTrigger({
      candidate,
      start:
        start ??
        (async (input) => await startAutomatedFlowRun(input, dependencies)),
    });
    switch (outcome.status) {
      case "skipped":
        outcomes.skipped += 1;
        break;
      case "settled":
        outcomes.settled += 1;
        // audit: skip — settle a derived receipt after a durable run or terminal skip.
        await database
          .delete(flowUploadTriggerIntents)
          .where(
            and(
              eq(
                flowUploadTriggerIntents.definitionId,
                candidate.intent.definitionId,
              ),
              eq(flowUploadTriggerIntents.entityId, candidate.intent.entityId),
            ),
          );
        break;
      case "paused":
        outcomes.paused += 1;
        break;
      case "retry":
        outcomes.retry += 1;
        break;
      default: {
        outcome satisfies never;
        panic("Unexpected upload flow trigger outcome");
      }
    }
  }
  return outcomes;
};

export const recoverUploadFlowTriggers: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    return;
  }
  const outcomes = await recoverUploadFlowTriggerIntents({
    database: db,
    now: dueAt.claimedAtDate(),
    signal,
  });
  logger.info("scheduler.upload_flow_triggers_recovered", outcomes);
};
