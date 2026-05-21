import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { rootDb } from "@/api/db/root";
import { infoSoudTrackedCases } from "@/api/db/schema";
import { createInfoSoudClient } from "@/api/handlers/workspaces/infosoud-common";
import { errorTag } from "@/api/lib/errors/utils";
import {
  buildInfoSoudAgendaItems,
  importInfoSoudAgendaItems,
} from "@/api/lib/infosoud/agenda-import";
import { LIMITS } from "@/api/lib/limits";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const INFO_SOUD_SYNC_TRACKED_CASES_TASK =
  "infosoud.syncTrackedCases" as const;

export const syncInfoSoudTrackedCases: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const client = createInfoSoudClient();
  const syncStartedAt = new Date();
  let synced = 0;
  let failed = 0;
  let total = 0;

  while (!signal.aborted) {
    const trackedCases = await loadNextTrackedCaseBatch(syncStartedAt);
    if (trackedCases.length === 0) {
      break;
    }

    total += trackedCases.length;

    for (const trackedCase of trackedCases) {
      // eslint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can flip between scheduler awaits.
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

        // eslint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can flip while the external lookup is in flight.
        if (signal.aborted) {
          break;
        }

        if (agendaItems.length > LIMITS.infoSoudAgendaImportItemsMax) {
          await markTrackedCaseFailed({
            error: "InfoSoudAgendaImportLimit",
            trackedCaseId: trackedCase.id,
          });
          failed += 1;
          continue;
        }

        const importResult = await rootDb.transaction(async (tx) => {
          const result = await importInfoSoudAgendaItems({
            actorUserId: trackedCase.createdBy,
            agendaItems,
            tx,
            workspaceId: trackedCase.workspaceId,
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
          await markTrackedCaseFailed({
            error: "InfoSoudAgendaImportFailed",
            trackedCaseId: trackedCase.id,
          });
          failed += 1;
          continue;
        }

        synced += 1;
      } catch (error: unknown) {
        // eslint-disable-next-line typescript/no-unnecessary-condition -- Avoid marking an intentionally aborted task as a failed tracked case.
        if (signal.aborted) {
          break;
        }

        await markTrackedCaseFailed({
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
    throw new Error("SchedulerAborted");
  }
};

const loadNextTrackedCaseBatch = async (syncStartedAt: Date) =>
  await rootDb
    .select()
    .from(infoSoudTrackedCases)
    .where(
      and(
        eq(infoSoudTrackedCases.enabled, true),
        or(
          isNull(infoSoudTrackedCases.lastSyncAttemptAt),
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
  error: string;
  trackedCaseId: typeof infoSoudTrackedCases.$inferSelect.id;
};

const markTrackedCaseFailed = async ({
  error,
  trackedCaseId,
}: MarkTrackedCaseFailedOptions): Promise<void> => {
  await rootDb
    .update(infoSoudTrackedCases)
    .set({
      lastSyncAttemptAt: new Date(),
      lastSyncError: error,
    })
    .where(eq(infoSoudTrackedCases.id, trackedCaseId));
};
