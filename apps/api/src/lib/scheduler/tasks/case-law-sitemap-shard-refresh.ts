import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { CorpusSchemaLaneUnavailableError } from "@/api/db/corpus-schema-lane";
import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import { executedRows } from "@/api/lib/db/executed-rows";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type {
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const LOCK_RETRY_DELAY_MS = 60_000;

export const REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK =
  "caseLaw.refreshSitemapShards" as const;

/** The database's clock plus the lock retry delay, for a delayed run. */
const delayedRunAt = async (
  db: SchedulerTaskContext["db"],
  dueAt: SchedulerTaskContext["dueAt"],
): Promise<Date> => {
  const nextRunAt = dueAt.claimedAtDate();
  const current = v.parse(
    v.object({ epoch_ms: v.number() }),
    executedRows(
      await db.execute(
        sql`SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS epoch_ms`,
      ),
    ).at(0),
  );
  nextRunAt.setTime(current.epoch_ms + LOCK_RETRY_DELAY_MS);
  return nextRunAt;
};

/**
 * Recount the public case-law sitemap months the change log names. A run that
 * stops between months continues at once from the rows still logged. A run a
 * schema upgrade refuses the corpus schema lane to continues after the lock
 * retry delay, from the months it left logged.
 */
export const refreshCaseLawSitemapShardsTask: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  runId,
  scheduleContinuation,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const refreshed = (
    await Result.tryPromise({
      try: async () => await refreshCaseLawSitemapShards(db, { signal }),
      catch: (cause: unknown) => cause,
    })
  ).tryRecover((cause) =>
    // A run refused the corpus schema lane yields to the schema upgrade.
    CorpusSchemaLaneUnavailableError.is(cause)
      ? Result.ok({ type: "yielded" as const })
      : Result.err(
          new SchedulerTaskFailure({
            message: "Case-law sitemap shard refresh failed",
            cause,
          }),
        ),
  );
  if (refreshed.isErr()) {
    return Result.err(refreshed.error);
  }
  const outcome = refreshed.value;
  switch (outcome.type) {
    case "yielded":
      logger.info("scheduler.case_law_sitemap_shards_yielded");
      scheduleContinuation(await delayedRunAt(db, dueAt));
      return undefined;
    case "pending": {
      logger.info("scheduler.case_law_sitemap_shards_pending", {
        "caseLawSitemap.months": outcome.months,
      });
      scheduleContinuation(
        outcome.retry === "delayed"
          ? await delayedRunAt(db, dueAt)
          : dueAt.claimedAtDate(),
      );
      return undefined;
    }
    case "refreshed":
      await recordSystemAudit(db, "system:case-law-sitemap-refresh", {
        subject: runId,
        counts: { months: outcome.months, shards: outcome.shards },
      });
      logger.info("scheduler.case_law_sitemap_shards_refreshed", {
        "caseLawSitemap.largestShard": outcome.largestShard,
        "caseLawSitemap.months": outcome.months,
        "caseLawSitemap.shards": outcome.shards,
      });
      return undefined;
    default:
      outcome satisfies never;
      return panic("Unknown sitemap refresh outcome");
  }
};
