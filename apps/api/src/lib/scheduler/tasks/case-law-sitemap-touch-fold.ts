import { Result } from "better-result";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BackfillHeldError,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { loadGateHealthConfig } from "@/api/env-online-index";
import {
  foldCaseLawSitemapTouches,
  readSitemapTouchDepth,
  SITEMAP_TOUCH_FOLD_BATCH_LIMIT,
} from "@/api/lib/case-law/sitemap-touch-fold";
import type { SitemapTouchFold } from "@/api/lib/case-law/sitemap-touch-fold";
import {
  logSchedulerBackfillStatus,
  SCHEDULER_BACKFILL_IDS,
} from "@/api/lib/scheduler/backfill-config";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";

export const FOLD_CASE_LAW_SITEMAP_TOUCHES_TASK =
  "caseLaw.foldSitemapTouches" as const;

/** Folding stops this long into a run; the next minutely run continues. */
const SITEMAP_TOUCH_FOLD_RUN_BUDGET_MS = 45_000;
// Leave room for a governed indicator read and one bounded batch transaction.
const BATCH_START_RESERVE_MS = 10_000;
/** The queue depth logged at the end of a run is read no further than this. */
const TOUCH_DEPTH_CAP = 100_000;

type SitemapTouchFoldOptions = {
  createRuntime?: typeof createScriptBackfillRuntime;
  clock?: () => number;
};

type BatchOutcome = {
  folded: number;
  retained: number;
  raised: number;
  /** Why this run stops after the batch, if it does. */
  stop: "empty" | "held" | "drained" | "blocked" | null;
};

/**
 * A batch stops the run when the queue is empty or drained, the fence is
 * held, or every claimed touch waits behind a writer still in flight.
 */
const batchOutcome = (folded: SitemapTouchFold): BatchOutcome => {
  if (folded.status !== "folded") {
    return { folded: 0, retained: 0, raised: 0, stop: folded.status };
  }
  let stop: BatchOutcome["stop"] = null;
  if (!folded.full) {
    stop = "drained";
  } else if (folded.folded === 0) {
    stop = "blocked";
  }
  return {
    folded: folded.folded,
    retained: folded.retained,
    raised: folded.raised,
    stop,
  };
};

/**
 * Fold the sitemap touch queue in governed batches for at most
 * `SITEMAP_TOUCH_FOLD_RUN_BUDGET_MS`. The run never asks for a continuation:
 * a backlog drains over consecutive minutely runs, each bounded in time and
 * paced by the load governor, so it neither runs back to back nor competes
 * with other jobs for reruns. A batch the shard fence or in-flight writers
 * hold back ends the run early; its touches stay queued.
 */
export const createCaseLawSitemapTouchFoldTask =
  ({
    createRuntime = createScriptBackfillRuntime,
    clock = () => performance.now(),
  }: SitemapTouchFoldOptions = {}): SchedulerTask =>
  async ({ db, logger, signal }) => {
    const deadline = clock() + SITEMAP_TOUCH_FOLD_RUN_BUDGET_MS;
    signal.throwIfAborted();
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(SITEMAP_TOUCH_FOLD_RUN_BUDGET_MS),
    ]);
    const healthConfig = loadGateHealthConfig();
    const maxBatchesPerRun =
      SITEMAP_TOUCH_FOLD_RUN_BUDGET_MS / healthConfig.minSleepMs;
    const runtime = createRuntime({
      db,
      name: SCHEDULER_BACKFILL_IDS.sitemapTouches,
      tableName: "case_law_sitemap_touches",
      initialSize: SITEMAP_TOUCH_FOLD_BATCH_LIMIT,
      config: {
        ...healthConfig,
        minSize: 128,
        maxSize: SITEMAP_TOUCH_FOLD_BATCH_LIMIT,
        batchStatementTimeoutMs: 5000,
        batchLockTimeoutMs: 1000,
      },
      observeStatus: logSchedulerBackfillStatus,
      reporting: "changes",
      statementTimeoutPolicy: "fail",
    });
    const totals = { batches: 0, folded: 0, retained: 0, raised: 0 };
    const outcome = await Result.tryPromise({
      try: async () => {
        try {
          for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
            if (clock() + BATCH_START_RESERVE_MS >= deadline) {
              return "budget" as const;
            }
            boundedSignal.throwIfAborted();
            const result = await runtime.step(async ({ tx, size }) => {
              boundedSignal.throwIfAborted();
              const value = batchOutcome(
                await foldCaseLawSitemapTouches(tx, size),
              );
              return { cursor: null, done: value.stop !== null, value };
            });
            totals.batches += 1;
            totals.folded += result.value.folded;
            totals.retained += result.value.retained;
            totals.raised += result.value.raised;
            if (result.value.stop !== null) {
              return result.value.stop;
            }
            if (clock() + result.sleepMs + BATCH_START_RESERVE_MS >= deadline) {
              return "budget" as const;
            }
            await sleep(result.sleepMs, undefined, { signal: boundedSignal });
          }
          return "budget" as const;
        } finally {
          await runtime.close();
        }
      },
      catch: (cause: unknown) => cause,
    });
    if (outcome.isErr()) {
      if (outcome.error instanceof BackfillHeldError) {
        logger.info("scheduler.case_law_sitemap_touches_held");
        return Result.ok();
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: "Case-law sitemap touch fold failed",
          cause: outcome.error,
        }),
      );
    }
    // The depth is read only when the run stopped with work left queued.
    const queued =
      outcome.value === "budget" || outcome.value === "blocked"
        ? await readSitemapTouchDepth(db, TOUCH_DEPTH_CAP)
        : 0;
    logger.info("scheduler.case_law_sitemap_touches_folded", {
      "caseLawSitemap.touchBatches": totals.batches,
      "caseLawSitemap.touchesFolded": totals.folded,
      "caseLawSitemap.touchesRetained": totals.retained,
      "caseLawSitemap.shardsRaised": totals.raised,
      "caseLawSitemap.touchesQueued": queued,
      "caseLawSitemap.touchFoldStop": outcome.value,
    });
    return Result.ok();
  };

export const foldCaseLawSitemapTouchesTask =
  createCaseLawSitemapTouchFoldTask();
