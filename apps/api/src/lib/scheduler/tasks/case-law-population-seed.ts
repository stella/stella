import { panic, Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { caseLawPopulationSeedState } from "@/api/db/schema";
import { CASE_LAW_POPULATION_SEED_REPAIR_NAME } from "@/api/lib/case-law/population-count-limits";
import {
  CASE_LAW_POPULATION_SEED_BATCH_SIZE,
  caseLawPopulationSeedBatchSize,
  caseLawPopulationSeedConfig,
  readCaseLawPopulationSeedBatch,
  retryLockRefusal,
} from "@/api/lib/case-law/population-seed-batch";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  logSchedulerBackfillStatus,
  schedulerBackfillConfig,
} from "@/api/lib/scheduler/backfill-config";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const SEED_CASE_LAW_POPULATION_COUNTS_TASK =
  "caseLaw.seedPopulationCounts" as const;

const RUN_BUDGET_MS = 45_000;
/**
 * Room for a governed indicator read and a typical seed batch; a batch that
 * starts before this point ends within its statement timeout.
 */
const BATCH_START_RESERVE_MS = 10_000;

type PopulationSeedOptions = {
  createRuntime?: typeof createScriptBackfillRuntime;
  clock?: () => number;
};

/**
 * Startup admits the population seed pending under any release, so the seed
 * cannot depend on a migrate run surviving long enough to finish it. This
 * owner resumes the online repair's own checkpoint (same runtime name, same
 * batch bounds, same heavy-work slot) in load-governed, bounded runs until
 * the seed reports complete; afterwards each run is one primary-key read.
 */
export const createCaseLawPopulationSeedTask =
  ({
    createRuntime = createScriptBackfillRuntime,
    clock = () => performance.now(),
  }: PopulationSeedOptions = {}): SchedulerTask =>
  async ({
    db,
    logger,
    runId,
    signal,
    scheduleContinuation,
    dueAt,
  }): Promise<Result<void, SchedulerTaskFailure>> => {
    signal.throwIfAborted();
    const [state] = await db
      .select({ phase: caseLawPopulationSeedState.phase })
      .from(caseLawPopulationSeedState)
      .where(eq(caseLawPopulationSeedState.slot, 0));
    if (!state) {
      return panic("Case-law population seed state is missing");
    }
    if (state.phase === "complete") {
      return Result.ok();
    }
    const deadline = clock() + RUN_BUDGET_MS;
    const runtime = createRuntime({
      db,
      name: CASE_LAW_POPULATION_SEED_REPAIR_NAME,
      tableName: "case_law_decisions",
      initialSize: CASE_LAW_POPULATION_SEED_BATCH_SIZE,
      config: caseLawPopulationSeedConfig(schedulerBackfillConfig()),
      observeStatus: logSchedulerBackfillStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const outcome = await Result.tryPromise({
      try: async (): Promise<"complete" | "continued"> => {
        try {
          while (clock() + BATCH_START_RESERVE_MS < deadline) {
            signal.throwIfAborted();
            // db-await-in-loop: one governed batch at a time; the seed function serializes its callers.
            const result = await retryLockRefusal(
              async () =>
                await runtime.step(async ({ tx, size }) => {
                  signal.throwIfAborted();
                  const batch = readCaseLawPopulationSeedBatch(
                    executedRows(
                      await tx.execute(
                        sql`SELECT cursor, processed, done FROM public.seed_case_law_population_counts(${caseLawPopulationSeedBatchSize(size)})`,
                      ),
                    ).at(0),
                  );
                  await recordSystemAudit(
                    tx,
                    "system:case-law-population-seed",
                    {
                      subject: runId,
                      counts: { projectedDecisions: batch.value },
                    },
                  );
                  return batch;
                }),
            );
            logger.info("scheduler.case_law_population_seeded", {
              "caseLawPopulation.projected": result.value,
            });
            if (result.done) {
              return "complete";
            }
            if (clock() + result.sleepMs + BATCH_START_RESERVE_MS >= deadline) {
              break;
            }
            await sleep(result.sleepMs, undefined, { signal });
          }
          scheduleContinuation(dueAt.claimedAtDate());
          return "continued";
        } finally {
          await runtime.close();
        }
      },
      catch: (cause: unknown) => cause,
    });
    if (outcome.isErr()) {
      if (outcome.error instanceof BackfillHeldError) {
        logger.info("scheduler.case_law_population_seed_held");
        return Result.ok();
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: "Case-law population seed failed",
          cause: outcome.error,
        }),
      );
    }
    if (outcome.value === "complete") {
      logger.info("scheduler.case_law_population_seed_complete");
    }
    return Result.ok();
  };

export const seedCaseLawPopulationCountsTask =
  createCaseLawPopulationSeedTask();
