import { panic } from "better-result";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { infoSoudTrackedCases } from "@/api/db/schema";
import { errorTag } from "@/api/lib/errors/utils";
import {
  buildInfoSoudAgendaItems,
  importInfoSoudAgendaItems,
} from "@/api/lib/infosoud/agenda-import";
import { getInfoSoudClient } from "@/api/lib/infosoud/client";
import { LIMITS } from "@/api/lib/limits";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const INFO_SOUD_SYNC_TRACKED_CASES_TASK =
  "infosoud.syncTrackedCases" as const;

export const syncInfoSoudTrackedCases: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  const client = getInfoSoudClient();
  const syncStartedAt = new Date();
  let synced = 0;
  let failed = 0;
  let total = 0;

  while (!signal.aborted) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- page loop: the page query skips cases this run already stamped, so the next page exists only after this one's attempts land
    const trackedCases = await loadNextTrackedCaseBatch(db, syncStartedAt);
    if (trackedCases.length === 0) {
      break;
    }

    total += trackedCases.length;

    for (const trackedCase of trackedCases) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can flip between scheduler awaits.
      if (signal.aborted) {
        break;
      }

      try {
        const lookupResult = await client.searchCaseWithHearings({
          courtCode: trackedCase.courtCode,
          signal,
          spisZn: trackedCase.spisZn,
        });
        const agendaItems = buildInfoSoudAgendaItems(
          lookupResult.case,
          lookupResult.hearings.udalosti,
        );

        // oxlint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can flip while the external lookup is in flight.
        if (signal.aborted) {
          break;
        }

        if (agendaItems.length > LIMITS.infoSoudAgendaImportItemsMax) {
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- the attempt stamp lands right after this case's throttled court lookup, so an abort mid-page resumes at the first unstamped case
          await markTrackedCaseFailed({
            db,
            error: "InfoSoudAgendaImportLimit",
            trackedCaseId: trackedCase.id,
          });
          failed += 1;
          continue;
        }

        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one transaction per tracked case, after its own throttled court lookup; a thrown error rolls back only that case, and a refused import returns before writing anything
        const importResult = await db.transaction(async (tx) => {
          const workspace = await tx.query.workspaces.findFirst({
            where: { id: { eq: trackedCase.workspaceId } },
            columns: { organizationId: true },
          });
          const result = await importInfoSoudAgendaItems({
            actorUserId: trackedCase.createdBy,
            agendaItems,
            tx,
            workspaceId: trackedCase.workspaceId,
            // A tracked case has been imported before, so every new hearing
            // is a change worth surfacing.
            signals: workspace
              ? { organizationId: workspace.organizationId }
              : undefined,
          });

          if (!result.ok) {
            return result;
          }

          await markTrackedCaseSynced({
            trackedCaseId: trackedCase.id,
            tx,
          });

          return result;
        });

        if (!importResult.ok) {
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- the attempt stamp lands right after this case's throttled court lookup, so an abort mid-page resumes at the first unstamped case
          await markTrackedCaseFailed({
            db,
            error: "InfoSoudAgendaImportFailed",
            trackedCaseId: trackedCase.id,
          });
          failed += 1;
          continue;
        }

        synced += 1;
      } catch (error: unknown) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Avoid marking an intentionally aborted task as a failed tracked case.
        if (signal.aborted) {
          break;
        }

        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- the attempt stamp lands right after this case's throttled court lookup, so an abort mid-page resumes at the first unstamped case
        await markTrackedCaseFailed({
          db,
          error: errorTag(error),
          trackedCaseId: trackedCase.id,
        });
        failed += 1;
      }
    }
  }

  logger.info("scheduler.infosoud_sync_completed", {
    "infosoud.failed": failed,
    "infosoud.synced": synced,
    "infosoud.total": total,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }
};

const loadNextTrackedCaseBatch = async (db: SchedulerDb, syncStartedAt: Date) =>
  await db
    .select()
    .from(infoSoudTrackedCases)
    .where(
      and(
        eq(infoSoudTrackedCases.enabled, true),
        or(
          isNull(infoSoudTrackedCases.lastSyncAttemptAt),
          // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
          lt(infoSoudTrackedCases.lastSyncAttemptAt, syncStartedAt),
        ),
      ),
    )
    .orderBy(
      sql`${infoSoudTrackedCases.lastSyncAttemptAt} asc nulls first`,
      asc(infoSoudTrackedCases.id),
    )
    .limit(LIMITS.infoSoudTrackedCasesSyncBatch);

type MarkTrackedCaseSyncedOptions = {
  trackedCaseId: typeof infoSoudTrackedCases.$inferSelect.id;
  tx: Transaction;
};

const markTrackedCaseSynced = async ({
  trackedCaseId,
  tx,
}: MarkTrackedCaseSyncedOptions): Promise<void> => {
  const now = new Date();

  await tx
    .update(infoSoudTrackedCases)
    .set({
      lastSyncAttemptAt: now,
      lastSyncError: null,
      lastSyncedAt: now,
    })
    .where(eq(infoSoudTrackedCases.id, trackedCaseId));
};

type MarkTrackedCaseFailedOptions = {
  db: SchedulerDb;
  error: string;
  trackedCaseId: typeof infoSoudTrackedCases.$inferSelect.id;
};

const markTrackedCaseFailed = async ({
  db,
  error,
  trackedCaseId,
}: MarkTrackedCaseFailedOptions): Promise<void> => {
  await db
    .update(infoSoudTrackedCases)
    .set({
      lastSyncAttemptAt: new Date(),
      lastSyncError: error,
    })
    .where(eq(infoSoudTrackedCases.id, trackedCaseId));
};
