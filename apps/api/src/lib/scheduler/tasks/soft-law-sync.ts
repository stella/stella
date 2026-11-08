import { Result } from "better-result";

import type { RegisteredSoftLawAuthority } from "@/api/handlers/soft-law/adapters/registry";
import { servedRegisteredSoftLawAuthorities } from "@/api/handlers/soft-law/served-sources";
import { syncSoftLaw } from "@/api/handlers/soft-law/sync";
import { getCaseLawIngestionDb } from "@/api/lib/case-law-ingestion-db";
import type {
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";

export const SYNC_SOFT_LAW_TASK = "softLaw.sync" as const;

export type SoftLawSyncDependencies = {
  authorities: () => readonly RegisteredSoftLawAuthority[];
  sync: (options: {
    authority: RegisteredSoftLawAuthority;
    signal: AbortSignal;
  }) => Promise<{ status: string }>;
};

const DEFAULT_DEPENDENCIES: SoftLawSyncDependencies = {
  authorities: servedRegisteredSoftLawAuthorities,
  sync: async ({ authority, signal }) =>
    await syncSoftLaw({
      authority,
      configuration: { type: "default" },
      scopedDb: getCaseLawIngestionDb(),
      signal,
    }),
};

/**
 * Runs one bounded sync per source with a serving decision. A sync registers
 * its source row on first run, so nothing needs seeding beforehand; a run that
 * stops early resumes from the source's stored cursor on the next slot.
 */
export const runSoftLawSync = async (
  { logger, signal }: Pick<SchedulerTaskContext, "logger" | "signal">,
  { authorities, sync }: SoftLawSyncDependencies = DEFAULT_DEPENDENCIES,
) => {
  const failed: string[] = [];
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

export const syncSoftLawTask: SchedulerTask = async (context) =>
  await runSoftLawSync(context);
