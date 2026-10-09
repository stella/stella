import { panic } from "better-result";
import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { flowDefinitions, schedulerJobs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateRowQuery,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { writeSchedulerBookkeeping } from "@/api/lib/db/recovery-bookkeeping/scheduler";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  backgroundFeatureMemberExists,
  isBackgroundFeatureEnabled,
} from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import {
  flowScheduleToSchedulerSchedule,
  flowScheduleToSchedulerScheduleSql,
} from "@/api/lib/flows/flow-trigger-logic";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
  flowScheduleJobIdSql,
  flowRunPayloadSchema,
  flowRunPayloadMatchesSql,
} from "@/api/lib/scheduler/tasks/flow-run";
import {
  schedulerSchedulesEqual,
  upsertSchedulerJob,
} from "@/api/lib/scheduler/upsert-job";

type SyncFlowScheduleTriggerOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  definitionId: SafeId<"flowDefinition">;
};

/** The definition write and its current admitted schedule commit together. */
export const syncFlowScheduleTriggerInTransaction = async ({
  tx,
  organizationId,
  definitionId,
}: SyncFlowScheduleTriggerOptions): Promise<void> => {
  await lockFeatureRecoveryAdmission({
    tx,
    organizationId,
    featureId: "flows",
  });
  const acquired = await withAggregateRowQuery({
    aggregate: "definition",
    id: { id: definitionId, organizationId },
    tx,
    mode: "no key update",
    select: (queryTx) =>
      queryTx
        .select({
          id: flowDefinitions.id,
          organizationId: flowDefinitions.organizationId,
          enabled: flowDefinitions.enabled,
          trigger: flowDefinitions.trigger,
          createdByUserId: flowDefinitions.createdByUserId,
        })
        .from(flowDefinitions)
        .limit(1),
  });
  if (acquired.status === "busy") {
    panic("Blocking aggregate acquisition returned busy");
  }
  const definition = acquired.rows.at(0);
  const jobId = flowScheduleJobId(definitionId);
  if (definition === undefined || definition.trigger.type !== "schedule") {
    await writeSchedulerBookkeeping({
      type: "delete-source",
      db: tx,
      table: schedulerJobs,
      jobId,
    });
    return;
  }
  const existing = (
    await tx
      .select({
        schedule: schedulerJobs.schedule,
        task: schedulerJobs.task,
        payload: schedulerJobs.payload,
      })
      .from(schedulerJobs)
      .where(eq(schedulerJobs.id, jobId))
      .limit(1)
  ).at(0);
  const enabled =
    definition.enabled &&
    (await isBackgroundFeatureEnabled({
      tx,
      organizationId,
      userId: definition.createdByUserId,
      featureId: "flows",
    }));
  if (!enabled && existing === undefined) {
    return;
  }
  const schedule = flowScheduleToSchedulerSchedule(definition.trigger.schedule);
  const existingPayload = v.safeParse(flowRunPayloadSchema, existing?.payload);
  const unchanged =
    existing !== undefined &&
    existing.task === FLOW_RUN_TASK &&
    existingPayload.success &&
    existingPayload.output.definitionId === definitionId &&
    schedulerSchedulesEqual(existing.schedule, schedule);
  await upsertSchedulerJob(
    {
      id: jobId,
      task: FLOW_RUN_TASK,
      description: `Scheduled flow run for definition ${definitionId}`,
      schedule,
      enabled,
      payload: { definitionId },
      payloadUpdate: unchanged ? "preserve" : "replace",
    },
    tx,
  );
};

type RepairFlowScheduleTriggersOptions = {
  database: Pick<Transaction, "select"> & {
    transaction: <Value>(
      run: (tx: Transaction) => Promise<Value>,
    ) => Promise<Value>;
  };
  principal?: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  };
  signal?: AbortSignal;
  batchSize?: number;
};

type RepairOrphanedFlowScheduleJobsOptions = Pick<
  RepairFlowScheduleTriggersOptions,
  "database" | "signal" | "batchSize"
>;

/** Missing definitions have no tenant or executable source; cleanup is operational. */
const repairOrphanedFlowScheduleJobs = async ({
  database,
  signal,
  batchSize = LIMITS.flowDefinitionsCount,
}: RepairOrphanedFlowScheduleJobsOptions): Promise<void> => {
  let cursor: string | null = null;
  const missingDefinition = sql`NOT EXISTS (
    SELECT 1 FROM ${flowDefinitions}
    WHERE ${flowDefinitions.id}::text = lower(${schedulerJobs.payload}->>'definitionId')
  )`;
  for (;;) {
    if (signal?.aborted) {
      break;
    }
    const cursorPredicate: SQL | undefined =
      cursor === null ? undefined : gt(schedulerJobs.id, cursor);
    // db-await-in-loop: each bounded page advances through orphan scheduling rows.
    const page = await readCursorPage(
      database
        .select({ id: schedulerJobs.id, payload: schedulerJobs.payload })
        .from(schedulerJobs)
        .where(
          and(
            eq(schedulerJobs.task, FLOW_RUN_TASK),
            cursorPredicate,
            missingDefinition,
          ),
        )
        .orderBy(asc(schedulerJobs.id)),
      { limit: batchSize, cursorForItem: (row) => row.id },
    );
    const originals = page.items.flatMap((job) => {
      const parsed = v.safeParse(
        v.pipe(v.string(), v.uuid()),
        job.payload?.["definitionId"],
      );
      if (
        job.payload === null ||
        !parsed.success ||
        flowScheduleJobId(parsed.output) !== job.id
      ) {
        logger.warn("flow.schedule_invalid_payload", { jobId: job.id });
        return [];
      }
      return [{ id: job.id, payload: job.payload }];
    });
    if (originals.length > 0 && !signal?.aborted) {
      // db-await-in-loop: one exact-source orphan cleanup transaction per page.
      await withAggregateTransaction(database, async (tx) => {
        await writeSchedulerBookkeeping({
          type: "delete-orphans",
          db: tx,
          table: schedulerJobs,
          definitions: flowDefinitions,
          task: FLOW_RUN_TASK,
          originals,
        });
      });
    }
    if (page.nextCursor === null) {
      return;
    }
    cursor = page.nextCursor;
  }
};

/** Only drift consumes repair transactions; locked sync revalidates each source. */
export const repairFlowScheduleTriggers = async ({
  database,
  principal,
  signal,
  batchSize = LIMITS.flowDefinitionsCount,
}: RepairFlowScheduleTriggersOptions): Promise<void> => {
  let cursor: SafeId<"flowDefinition"> | null = null;
  const expectedEnabled = sql`(
    ${flowDefinitions.enabled}
    AND ${isDeploymentFeatureEnabled(FEATURE_REGISTRY.flows.deploymentFeature)}
    AND ${backgroundFeatureMemberExists({
      organizationId: flowDefinitions.organizationId,
      userId: flowDefinitions.createdByUserId,
      featureId: "flows",
    })}
  )`;
  const drift = sql`CASE WHEN ${flowDefinitions.trigger}->>'type' = 'schedule' THEN (
    CASE WHEN ${schedulerJobs.id} IS NULL THEN ${expectedEnabled} ELSE (
      ${schedulerJobs.task} IS DISTINCT FROM ${FLOW_RUN_TASK}
      OR ${schedulerJobs.schedule} IS DISTINCT FROM (${flowScheduleToSchedulerScheduleSql(sql`${flowDefinitions.trigger}->'schedule'`)})
      OR ${schedulerJobs.enabled} IS DISTINCT FROM ${expectedEnabled}
      OR NOT ${flowRunPayloadMatchesSql({ payload: schedulerJobs.payload, definitionId: flowDefinitions.id })}
    ) END
  ) ELSE ${schedulerJobs.id} IS NOT NULL END`;
  for (;;) {
    if (signal?.aborted) {
      break;
    }
    const cursorPredicate: SQL | undefined =
      cursor === null ? undefined : gt(flowDefinitions.id, cursor);
    // db-await-in-loop: each bounded keyset page advances through durable definitions.
    const page = await readCursorPage(
      database
        .select({
          id: flowDefinitions.id,
          organizationId: flowDefinitions.organizationId,
        })
        .from(flowDefinitions)
        .leftJoin(
          schedulerJobs,
          eq(schedulerJobs.id, flowScheduleJobIdSql(flowDefinitions.id)),
        )
        .where(
          and(
            drift,
            cursorPredicate,
            principal === undefined
              ? undefined
              : and(
                  eq(flowDefinitions.organizationId, principal.organizationId),
                  eq(flowDefinitions.createdByUserId, principal.userId),
                ),
          ),
        )
        .orderBy(asc(flowDefinitions.id)),
      { limit: batchSize, cursorForItem: (row) => row.id },
    );
    for (const definition of page.items) {
      if (signal?.aborted) {
        return;
      }
      // db-await-in-loop: each definition gets an independent ordered admission transaction.
      await withAggregateTransaction(database, async (tx) => {
        await syncFlowScheduleTriggerInTransaction({
          tx,
          organizationId: definition.organizationId,
          definitionId: definition.id,
        });
      });
    }
    if (page.nextCursor === null) {
      break;
    }
    const last = page.items.at(-1);
    if (last === undefined) {
      panic("Schedule repair cursor requires a source row");
    }
    cursor = last.id;
  }
  // Scoped regrant cannot attribute a deleted definition to a principal;
  // the standing system repair owns source-less scheduling cleanup.
  if (principal === undefined) {
    await repairOrphanedFlowScheduleJobs({
      database,
      batchSize,
      ...(signal === undefined ? {} : { signal }),
    });
  }
};
