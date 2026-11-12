import { Result } from "better-result";

import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";

export const SYNC_SOFT_LAW_TASK = "softLaw.sync" as const;

type SoftLawSyncDependencies<Authority extends string> = {
  authorities: () => readonly Authority[];
  sync: (options: {
    authority: Authority;
    signal: AbortSignal;
  }) => Promise<{ status: string }>;
};

/**
 * Runs one bounded sync per source with a serving decision. A sync registers
 * its source row on first run, so nothing needs seeding beforehand; a run that
 * stops early resumes from the source's stored cursor on the next slot. The
 * soft-law slice supplies the sources and the sync, so scheduler code does not
 * depend on handlers.
 */
export const createSoftLawSyncTask =
  <Authority extends string>({
    authorities,
    sync,
  }: SoftLawSyncDependencies<Authority>): SchedulerTask =>
  async ({ logger, signal }) => {
    const failed: Authority[] = [];
    for (const authority of authorities()) {
      signal.throwIfAborted();
      const outcome = await sync({ authority, signal });
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
