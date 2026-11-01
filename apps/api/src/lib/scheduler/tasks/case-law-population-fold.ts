import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";

import { defaultConfig } from "@stll/db-load-gate/health";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { CASE_LAW_POPULATION_FOLD_BATCH_LIMIT } from "@/api/lib/case-law/population-count-limits";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  logSchedulerBackfillStatus,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";
import { isRecord } from "@/api/lib/type-guards";

export const FOLD_CASE_LAW_POPULATION_COUNTS_TASK =
  "caseLaw.foldPopulationCounts" as const;

const RUN_BUDGET_MS = 45_000;
// Leave room for a governed indicator read and one bounded write transaction.
const BATCH_START_RESERVE_MS = 10_000;
const MAX_BATCHES_PER_RUN = RUN_BUDGET_MS / defaultConfig.minSleepMs;

type PopulationFoldOptions = {
  createRuntime?: typeof createScriptBackfillRuntime;
  clock?: () => number;
};

/** Writers append deltas; this owner folds bounded batches in separate transactions. */
export const createCaseLawPopulationFoldTask =
  ({
    createRuntime = createScriptBackfillRuntime,
    clock = performance.now,
  }: PopulationFoldOptions = {}): SchedulerTask =>
  async ({ db, logger, runId, signal, scheduleContinuation, dueAt }) => {
    const deadline = clock() + RUN_BUDGET_MS;
    signal.throwIfAborted();
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(RUN_BUDGET_MS),
    ]);
    const runtime = createRuntime({
      db,
      name: SCHEDULER_BACKFILL_IDS.populationCounts,
      tableName: "case_law_population_deltas",
      initialSize: CASE_LAW_POPULATION_FOLD_BATCH_LIMIT,
      config: {
        ...defaultConfig,
        minSize: 128,
        maxSize: CASE_LAW_POPULATION_FOLD_BATCH_LIMIT,
        batchStatementTimeoutMs: 5000,
        batchLockTimeoutMs: 1000,
      },
      observeStatus: logSchedulerBackfillStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const outcome = await Result.tryPromise({
      try: async () => {
        try {
          for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
            if (clock() + BATCH_START_RESERVE_MS >= deadline) {
              scheduleContinuation(dueAt.claimedAtDate());
              return;
            }
            boundedSignal.throwIfAborted();
            const result = await runtime.step(async ({ tx, size }) => {
              boundedSignal.throwIfAborted();
              const row = executedRows(
                await tx.execute(sql`
              SELECT folded, done FROM public.fold_case_law_population_counts(${size})
            `),
              ).find(isRecord);
              if (
                !row ||
                typeof row["folded"] !== "number" ||
                typeof row["done"] !== "boolean"
              ) {
                return panic("Invalid case-law population fold result");
              }
              await recordSystemAudit(tx, "system:case-law-population-fold", {
                subject: runId,
                counts: { deltas: row["folded"] },
              });
              return {
                cursor: null,
                done: row["done"],
                value: { folded: row["folded"], done: row["done"] },
              };
            });
            logger.info("scheduler.case_law_population_folded", {
              "caseLawPopulation.deltas": result.value.folded,
            });
            if (result.value.done) {
              return;
            }
            if (result.value.folded === 0) {
              return;
            }
            if (clock() + result.sleepMs + BATCH_START_RESERVE_MS >= deadline) {
              scheduleContinuation(dueAt.claimedAtDate());
              return;
            }
            await sleep(result.sleepMs, undefined, { signal: boundedSignal });
          }
          scheduleContinuation(dueAt.claimedAtDate());
        } finally {
          await runtime.close();
        }
      },
      catch: (cause: unknown) => cause,
    });
    if (outcome.isErr()) {
      if (outcome.error instanceof BackfillHeldError) {
        logger.info("scheduler.case_law_population_fold_held");
        return;
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: "Case-law population fold failed",
          cause: outcome.error,
        }),
      );
    }
  };

export const foldCaseLawPopulationCountsTask =
  createCaseLawPopulationFoldTask();
