import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { isUuid } from "@stll/uuid-codec";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import type { ScopedDb } from "@/api/db/safe-db";
import { schedulerJobs } from "@/api/db/schema";
import { reconcilePublisherRemovals } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
import { selectDueErasureSources } from "@/api/lib/legal-search/removal-reconciliation-store";
import { brandPersistedCaseLawSourceId } from "@/api/lib/safe-id-boundaries";
import {
  SCHEDULER_BACKFILL_CONFIG,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";

export const RECONCILE_PUBLISHER_REMOVALS_TASK =
  "caseLaw.reconcilePublisherRemovals" as const;

/** A source-scoped task; registration creates no schedule or source configuration. */
export const reconcilePublisherRemovalsTask: SchedulerTask = async ({
  payload,
  signal,
  scheduleContinuation,
  logger,
  dueAt,
}) => {
  const sourceId = payload?.["sourceId"];
  if (typeof sourceId !== "string" || !isUuid(sourceId)) {
    panic("Publisher removal task requires a source UUID");
  }
  const result = await reconcilePublisherRemovals({
    scopedDb: getCaseLawIngestionDb(),
    sourceId: brandPersistedCaseLawSourceId(sourceId),
    signal,
  });
  if (result.isErr()) {
    return Result.err(
      new SchedulerTaskFailure({
        message: "Publisher removal sweep did not complete",
        cause: result.error,
      }),
    );
  }
  logger.info("scheduler.publisher_removals", {
    outcome: result.value.type,
    checked: result.value.checked,
    retried: result.value.retried,
  });
  if (result.value.type === "budget" || result.value.type === "contended") {
    scheduleContinuation(new Date(dueAt.claimedAtDate().getTime() + 1000));
  }
  if (
    result.value.type !== "budget" &&
    result.value.type !== "contended" &&
    result.value.nextRetryAt !== null
  ) {
    scheduleContinuation(result.value.nextRetryAt);
  }
  return Result.ok();
};

export const RECONCILE_CLAIMED_ERASURES_TASK =
  "caseLaw.reconcileClaimedErasures" as const;

type ClaimedErasureTaskOptions = {
  createRuntime?: typeof createScriptBackfillRuntime;
  scopedDb?: ScopedDb;
  reconcile?: typeof reconcilePublisherRemovals;
};

/** One admitted source page per run, independent of publisher discovery configuration. */
export const createReconcileClaimedErasuresTask =
  ({
    createRuntime = createScriptBackfillRuntime,
    scopedDb: database,
    reconcile = reconcilePublisherRemovals,
  }: ClaimedErasureTaskOptions = {}): SchedulerTask =>
  async ({ db, job, payload, signal, scheduleContinuation, dueAt }) => {
    const cursor = payload?.["cursor"] ?? null;
    if (cursor !== null && (typeof cursor !== "string" || !isUuid(cursor))) {
      return panic("Erasure source cursor requires a source UUID");
    }
    const runtime = createRuntime({
      db,
      name: SCHEDULER_BACKFILL_IDS.claimedErasures,
      tableName: "case_law_removal_reconciliation_items",
      initialSize: 1,
      config: { ...SCHEDULER_BACKFILL_CONFIG, minSize: 1, maxSize: 1 },
    });
    const settled = await Result.tryPromise({
      try: async () => {
        try {
          return await runtime.step<Result<boolean, SchedulerTaskFailure>>(
            async ({ tx, size }) => {
              signal.throwIfAborted();
              const scopedDb = database ?? getCaseLawIngestionDb();
              const sources = await selectDueErasureSources({
                scopedDb,
                after:
                  cursor === null
                    ? null
                    : brandPersistedCaseLawSourceId(cursor),
                now: dueAt.claimedAtDate(),
                limit: size,
              });
              const source = sources.at(0);
              if (source !== undefined) {
                const result = await reconcile({
                  scopedDb,
                  sourceId: source.id,
                  signal,
                  mode: "claimed-erasures",
                });
                if (result.isErr()) {
                  return {
                    cursor: null,
                    done: true,
                    value: Result.err(
                      new SchedulerTaskFailure({
                        message: "Claimed erasure retry did not complete",
                        cause: result.error,
                      }),
                    ),
                  };
                }
              }
              // audit: skip - lease-fenced scheduler progress, while each erasure has its canonical audit.
              await tx
                .update(schedulerJobs)
                .set({ payload: { cursor: source?.id ?? null } })
                .where(
                  and(
                    eq(schedulerJobs.id, job.id),
                    eq(
                      schedulerJobs.lockedBy,
                      job.lockedBy ??
                        panic("Erasure retry pass requires a scheduler lease"),
                    ),
                  ),
                );
              return {
                cursor: null,
                done: true,
                value: Result.ok(source !== undefined),
              };
            },
          );
        } finally {
          await runtime.close();
        }
      },
      catch: (cause) => cause,
    });
    if (settled.isErr()) {
      if (settled.error instanceof BackfillHeldError) {
        return Result.ok();
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: "Claimed erasure retry pass failed",
          cause: settled.error,
        }),
      );
    }
    if (settled.value.value.isErr()) {
      return settled.value.value;
    }
    if (settled.value.value.value) {
      scheduleContinuation(new Date(dueAt.claimedAtDate().getTime() + 1000));
    }
    return Result.ok();
  };

export const reconcileClaimedErasuresTask =
  createReconcileClaimedErasuresTask();
