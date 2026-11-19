import { Result } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
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
      const attempt = await Result.tryPromise({
        try: async () => await sync({ authority, signal }),
        catch: (error: unknown) => error,
      });
      // An aborted run stops here; any other rejection fails this source only.
      signal.throwIfAborted();
      if (Result.isError(attempt)) {
        captureError(
          attempt.error,
          handlerErrorContext("scheduler.softLawSync", {
            softLawAuthority: authority,
          }),
        );
      }
      const status = Result.isError(attempt) ? "failed" : attempt.value.status;
      logger.info("scheduler.soft_law_source_synced", {
        "soft_law.authority": authority,
        "soft_law.status": status,
      });
      if (status === "failed") {
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
