import { panic } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const LOCK_RETRY_DELAY_MS = 60_000;

export const REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK =
  "caseLaw.refreshSitemapShards" as const;

/**
 * Recount the public case-law sitemap months the change log names. A run that
 * stops between months continues at once from the rows still logged.
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
  const outcome = await refreshCaseLawSitemapShards(db, { signal });
  switch (outcome.type) {
    case "pending": {
      logger.info("scheduler.case_law_sitemap_shards_pending", {
        "caseLawSitemap.months": outcome.months,
      });
      const nextRunAt = dueAt.claimedAtDate();
      if (outcome.retry === "delayed") {
        const current = v.parse(
          v.object({ epoch_ms: v.number() }),
          executedRows(
            await db.execute(
              sql`SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS epoch_ms`,
            ),
          ).at(0),
        );
        nextRunAt.setTime(current.epoch_ms + LOCK_RETRY_DELAY_MS);
      }
      scheduleContinuation(nextRunAt);
      return;
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
      return;
    default:
      outcome satisfies never;
      panic("Unknown sitemap refresh outcome");
  }
};
