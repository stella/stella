import { Result } from "better-result";

import { servedRegisteredSoftLawAuthorities } from "@/api/handlers/soft-law/served-sources";
import { syncSoftLaw } from "@/api/handlers/soft-law/sync";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";

export const SYNC_SOFT_LAW_TASK = "softLaw.sync" as const;

/**
 * Runs one bounded sync per source with a serving decision. A sync registers
 * its source row on first run, so nothing needs seeding beforehand; a run that
 * stops early resumes from the source's stored cursor on the next slot.
 */
export const syncSoftLawTask: SchedulerTask = async ({ logger, signal }) => {
  const scopedDb = getCaseLawIngestionDb();
  const failed: string[] = [];
  for (const authority of servedRegisteredSoftLawAuthorities()) {
    signal.throwIfAborted();
    const outcome = await syncSoftLaw({
      authority,
      configuration: { type: "default" },
      scopedDb,
      signal,
    });
    logger.info("scheduler.soft_law_source_synced", {
      "soft_law.authority": authority,
      "soft_law.status": outcome.status,
    });
    if (outcome.status === "failed") {
      failed.push(authority);
    }
  }
  return failed.length === 0
    ? Result.ok()
    : Result.err(
        new SchedulerTaskFailure({
          message: `Soft-law sync failed for ${failed.join(", ")}`,
          cause: failed,
        }),
      );
};
