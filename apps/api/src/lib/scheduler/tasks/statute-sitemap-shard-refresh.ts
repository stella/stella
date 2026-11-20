import { panic } from "better-result";

import { withLongRunningConnection } from "@/api/db/long-running-connection";
import { refreshStatuteSitemapShards } from "@/api/lib/legal-search/statute-sitemap-shard-refresh";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REFRESH_STATUTE_SITEMAP_SHARDS_TASK =
  "legislation.refreshSitemapShards" as const;

const REFRESH_STATEMENT_TIMEOUT_MS = 5 * 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 10_000;

export const refreshStatuteSitemapShardsTask: SchedulerTask = async ({
  db,
  logger,
  runId,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { largestShard, shards } = await withLongRunningConnection(
    {
      lockTimeout: REFRESH_LOCK_TIMEOUT_MS,
      statementTimeout: REFRESH_STATEMENT_TIMEOUT_MS,
      signal,
    },
    async ({ db: refreshDb }) =>
      await refreshStatuteSitemapShards(refreshDb, { signal }),
  );
  signal.throwIfAborted();
  await recordSystemAudit(db, "system:statute-sitemap-refresh", {
    subject: runId,
    counts: { shards },
  });
  logger.info("scheduler.statute_sitemap_shards_refreshed", {
    "statuteSitemap.largestShard": largestShard,
    "statuteSitemap.shards": shards,
  });
};
