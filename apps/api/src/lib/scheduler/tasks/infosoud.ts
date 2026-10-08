import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type { InfoSoudClient } from "@stll/infosoud";

import type { Transaction } from "@/api/db/root";
import { infoSoudTrackedCases } from "@/api/db/schema";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { errorTag } from "@/api/lib/errors/utils";
import {
  buildInfoSoudAgendaItems,
  importInfoSoudAgendaItems,
} from "@/api/lib/infosoud/agenda-import";
import { getInfoSoudClient } from "@/api/lib/infosoud/client";
import { LIMITS } from "@/api/lib/limits";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";

export const INFO_SOUD_SYNC_TRACKED_CASES_TASK =
  "infosoud.syncTrackedCases" as const;

export const INFO_SOUD_SYNC_FAILURE_REASONS = [
  "agenda-limit",
  "import-refused",
  "case-failed",
] as const;

type InfoSoudSyncFailureReason =
  (typeof INFO_SOUD_SYNC_FAILURE_REASONS)[number];

export class InfoSoudSyncIncomplete extends TaggedError(
  "InfoSoudSyncIncomplete",
)<{
  message: string;
  failed: number;
  synced: number;
  superseded: number;
  total: number;
  reasons: Readonly<Record<InfoSoudSyncFailureReason, number>>;
}> {}

type CreateSyncInfoSoudTrackedCasesTaskOptions = {
  searchCaseWithHearings?: InfoSoudClient["searchCaseWithHearings"];
  importAgendaItems?: typeof importInfoSoudAgendaItems;
};

export const createSyncInfoSoudTrackedCasesTask =
  ({
    searchCaseWithHearings = async (input) =>
      await getInfoSoudClient().searchCaseWithHearings(input),
    importAgendaItems = importInfoSoudAgendaItems,
  }: CreateSyncInfoSoudTrackedCasesTaskOptions = {}) =>
  async ({ db, dueAt, logger, signal }: SchedulerTaskContext) => {
    const syncStartedAt = dueAt.claimedAtDate();
    let synced = 0;
    let superseded = 0;
    let total = 0;
    const reasons = {
      "agenda-limit": 0,
      "import-refused": 0,
      "case-failed": 0,
    } satisfies Record<InfoSoudSyncFailureReason, number>;

    while (!signal.aborted) {
      // db-await-in-loop: page loop: the page query skips cases this run already stamped, so the next page exists only after this one's attempts land
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
          const lookupResult = await searchCaseWithHearings({
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
            // db-await-in-loop: the attempt stamp lands right after this case's throttled court lookup, so an abort mid-page resumes at the first unstamped case
            const stamp = await markTrackedCaseFailed({
              attemptAt: syncStartedAt,
              db,
              error: "InfoSoudAgendaImportLimit",
              trackedCaseId: trackedCase.id,
            });
            if (stamp === "superseded") {
              superseded += 1;
            } else {
              reasons["agenda-limit"] += 1;
            }
            continue;
          }

          // db-await-in-loop: one transaction per tracked case, after its own throttled court lookup; a thrown error rolls back only that case, and a refused import returns before writing anything
          const importResult = await db.transaction(async (tx) => {
            // A newer writer may have claimed the case during the court
            // lookup. Re-assert the attempt fence under the row lock before
            // importing, so a superseded attempt writes nothing at all. The
            // workspace row is locked first: the manual re-import holds it
            // while upserting the tracked case, so the reverse order would
            // deadlock against that path.
            await lockWorkspacesForEntityCap(tx, [trackedCase.workspaceId]);
            const awaiting = await lockAwaitingTrackedCase(
              tx,
              trackedCase.id,
              syncStartedAt,
            );
            if (!awaiting) {
              return "superseded";
            }
            const workspace = await tx.query.workspaces.findFirst({
              where: { id: { eq: trackedCase.workspaceId } },
              columns: { organizationId: true },
            });
            const result = await importAgendaItems({
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
              return "import-refused";
            }

            return await markTrackedCaseSynced({
              syncedAt: syncStartedAt,
              trackedCaseId: trackedCase.id,
              tx,
            });
          });

          if (importResult === "import-refused") {
            // db-await-in-loop: the attempt stamp lands right after this case's throttled court lookup, so an abort mid-page resumes at the first unstamped case
            const stamp = await markTrackedCaseFailed({
              attemptAt: syncStartedAt,
              db,
              error: "InfoSoudAgendaImportFailed",
              trackedCaseId: trackedCase.id,
            });
            if (stamp === "superseded") {
              superseded += 1;
            } else {
              reasons["import-refused"] += 1;
            }
            continue;
          }

          if (importResult === "superseded") {
            superseded += 1;
          } else {
            synced += 1;
          }
        } catch (error: unknown) {
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- Avoid marking an intentionally aborted task as a failed tracked case.
          if (signal.aborted) {
            break;
          }

          // db-await-in-loop: the attempt stamp lands right after this case's throttled court lookup, so an abort mid-page resumes at the first unstamped case
          const stamp = await markTrackedCaseFailed({
            attemptAt: syncStartedAt,
            db,
            error: errorTag(error),
            trackedCaseId: trackedCase.id,
          });
          if (stamp === "superseded") {
            superseded += 1;
          } else {
            reasons["case-failed"] += 1;
          }
        }
      }
    }

    if (signal.aborted) {
      panic("SchedulerAborted");
    }

    const failed = Object.values(reasons).reduce(
      (count, value) => count + value,
      0,
    );
    const counts = {
      "infosoud.failed": failed,
      "infosoud.synced": synced,
      "infosoud.superseded": superseded,
      "infosoud.total": total,
    };

    if (superseded > 0) {
      logger.info("scheduler.infosoud_sync_superseded", counts);
    }

    if (failed > 0) {
      const error = new InfoSoudSyncIncomplete({
        message: "InfoSoud sync did not complete for every tracked case",
        failed,
        synced,
        superseded,
        total,
        reasons,
      });
      logger.warn("scheduler.infosoud_sync_incomplete", {
        ...counts,
        ...Object.fromEntries(
          Object.entries(reasons).map(([reason, count]) => [
            `infosoud.failure.${reason}`,
            count,
          ]),
        ),
      });
      return Result.err(
        new SchedulerTaskFailure({ message: error.message, cause: error }),
      );
    }
    logger.info("scheduler.infosoud_sync_completed", counts);
    return Result.ok(undefined);
  };

export const syncInfoSoudTrackedCases = createSyncInfoSoudTrackedCasesTask();

const awaitingSyncAttempt = (syncStartedAt: Date) =>
  or(
    isNull(infoSoudTrackedCases.lastSyncAttemptAt),
    // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- Run cutoff and attempt stamps share the same claim instant; equal or newer attempts are owned by another writer.
    lt(infoSoudTrackedCases.lastSyncAttemptAt, syncStartedAt),
  );

const loadNextTrackedCaseBatch = async (db: SchedulerDb, syncStartedAt: Date) =>
  await db
    .select()
    .from(infoSoudTrackedCases)
    .where(
      and(
        eq(infoSoudTrackedCases.enabled, true),
        awaitingSyncAttempt(syncStartedAt),
      ),
    )
    .orderBy(
      sql`${infoSoudTrackedCases.lastSyncAttemptAt} asc nulls first`,
      asc(infoSoudTrackedCases.id),
    )
    .limit(LIMITS.infoSoudTrackedCasesSyncBatch);

const lockAwaitingTrackedCase = async (
  tx: Transaction,
  trackedCaseId: typeof infoSoudTrackedCases.$inferSelect.id,
  syncStartedAt: Date,
) => {
  const locked = await tx
    .select({ id: infoSoudTrackedCases.id })
    .from(infoSoudTrackedCases)
    .where(
      and(
        eq(infoSoudTrackedCases.id, trackedCaseId),
        awaitingSyncAttempt(syncStartedAt),
      ),
    )
    .for("update");
  return locked.length > 0;
};

type MarkTrackedCaseSyncedOptions = {
  syncedAt: Date;
  trackedCaseId: typeof infoSoudTrackedCases.$inferSelect.id;
  tx: Transaction;
};

const markTrackedCaseSynced = async ({
  syncedAt,
  trackedCaseId,
  tx,
}: MarkTrackedCaseSyncedOptions) => {
  const stamped = await tx
    .update(infoSoudTrackedCases)
    .set({
      lastSyncAttemptAt: syncedAt,
      lastSyncError: null,
      lastSyncedAt: syncedAt,
    })
    .where(
      and(
        eq(infoSoudTrackedCases.id, trackedCaseId),
        awaitingSyncAttempt(syncedAt),
      ),
    )
    .returning({ id: infoSoudTrackedCases.id });
  return stamped.length === 0 ? "superseded" : "synced";
};

type MarkTrackedCaseFailedOptions = {
  attemptAt: Date;
  db: SchedulerDb;
  error: string;
  trackedCaseId: typeof infoSoudTrackedCases.$inferSelect.id;
};

const markTrackedCaseFailed = async ({
  attemptAt,
  db,
  error,
  trackedCaseId,
}: MarkTrackedCaseFailedOptions) => {
  const stamped = await db
    .update(infoSoudTrackedCases)
    .set({
      lastSyncAttemptAt: attemptAt,
      lastSyncError: error,
    })
    .where(
      and(
        eq(infoSoudTrackedCases.id, trackedCaseId),
        awaitingSyncAttempt(attemptAt),
      ),
    )
    .returning({ id: infoSoudTrackedCases.id });
  return stamped.length === 0 ? "superseded" : "failed";
};
