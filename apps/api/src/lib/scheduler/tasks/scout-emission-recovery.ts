import { panic, Result } from "better-result";
import { and, asc, eq, lte, sql } from "drizzle-orm";

import { entities, pendingScoutEmissions } from "@/api/db/schema";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorTag } from "@/api/lib/errors/error-tag";
import { findSignalsBackgroundActor } from "@/api/lib/feature-access/background";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  brandPersistedDocumentReviewRunId,
  brandPersistedEntityId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { emitDocumentReviewSignal } from "@/api/lib/scouts/document-review";
import { emitInfoSoudHearingSignals } from "@/api/lib/scouts/infosoud-hearings";
import { toHearingRecord } from "@/api/lib/scouts/infosoud-hearings.logic";

export const RECOVER_SCOUT_EMISSION_TASK =
  "signals.recoverScoutEmission" as const;
const SCOUT_EMISSION_FAILURE = failureSink({
  event: "scout.emission_recovery_failed",
  expected: [],
});
const RECOVERY_PAGE_SIZE = 100;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

/** Admission pauses retain source identities; emission and dequeue commit together. */
export const recoverScoutEmission: SchedulerTask = async ({
  db,
  dueAt,
  signal,
  logger,
}) => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return;
  }
  const now = dueAt.claimedAtDate();
  const pending = await db
    .select()
    .from(pendingScoutEmissions)
    .where(lte(pendingScoutEmissions.nextAttemptAt, sql`${now}::timestamptz`))
    .orderBy(
      asc(pendingScoutEmissions.nextAttemptAt),
      asc(pendingScoutEmissions.sourceId),
    )
    .limit(RECOVERY_PAGE_SIZE);
  for (const source of pending) {
    signal.throwIfAborted();
    // db-await-in-loop: bounded source page; independent atomic tenant emission and dequeue
    const recovery = await Result.tryPromise(() =>
      db.transaction(async (tx) => {
        const sourceWhere = and(
          eq(pendingScoutEmissions.organizationId, source.organizationId),
          eq(pendingScoutEmissions.sourceKind, source.sourceKind),
          eq(pendingScoutEmissions.sourceId, source.sourceId),
        );
        // A blocked recipient must not starve the rest of the bounded page.
        // audit: skip — retry bookkeeping on a durable source intent; scheduler_job_runs records attempts.
        const claimed = await tx
          .update(pendingScoutEmissions)
          .set({ nextAttemptAt: new Date(now.getTime() + RETRY_INTERVAL_MS) })
          .where(
            and(
              sourceWhere,
              lte(
                pendingScoutEmissions.nextAttemptAt,
                sql`${now}::timestamptz`,
              ),
            ),
          )
          .returning({ sourceId: pendingScoutEmissions.sourceId });
        if (claimed.length === 0) {
          return;
        }
        switch (source.sourceKind) {
          case "document-review": {
            if (!isDeploymentFeatureEnabled("FEATURE_INBOX_DOCUMENT_SCOUTS")) {
              return;
            }
            const outcome = await emitDocumentReviewSignal({
              tx,
              workspaceId: source.workspaceId,
              runId: brandPersistedDocumentReviewRunId(source.sourceId),
            });
            if (outcome === "paused") {
              logger.info("scout.emission_paused", {
                sourceKind: source.sourceKind,
              });
              return;
            }
            break;
          }
          case "infosoud-hearing": {
            if (
              (await findSignalsBackgroundActor({
                tx,
                organizationId: source.organizationId,
                workspaceId: source.workspaceId,
              })) === null
            ) {
              logger.info("scout.emission_paused", {
                sourceKind: source.sourceKind,
              });
              return;
            }
            const entityId = brandPersistedEntityId(source.sourceId);
            const entity = (
              await tx
                .select({
                  externalId: entities.externalId,
                  externalData: entities.externalData,
                  startAt: entities.startAt,
                })
                .from(entities)
                .where(
                  and(
                    eq(entities.id, entityId),
                    eq(entities.workspaceId, source.workspaceId),
                    eq(entities.externalSource, "infosoud"),
                  ),
                )
                .limit(1)
            ).at(0);
            const hearing = entity ? toHearingRecord(entity) : null;
            if (hearing) {
              await emitInfoSoudHearingSignals({
                tx,
                organizationId: source.organizationId,
                workspaceId: source.workspaceId,
                inserted: [{ entityId, hearing }],
                now,
              });
              // The emitter rechecks admission and owns dequeue; a revoked grant retains the intent.
              return;
            }
            break;
          }
          default:
            source.sourceKind satisfies never;
            return panic("Unknown deferred scout source");
        }
        // audit: skip — derived emission intent settled atomically with its audited signal.
        await tx.delete(pendingScoutEmissions).where(sourceWhere);
      }),
    );
    if (Result.isOk(recovery)) {
      continue;
    }
    // audit: skip — preserves a retryable source and its sanitized failure after emission rolled back.
    // db-await-in-loop: retry the failed source independently after its emission transaction rolled back
    await db
      .update(pendingScoutEmissions)
      .set({
        nextAttemptAt: new Date(now.getTime() + RETRY_INTERVAL_MS),
        lastError: errorTag(recovery.error.cause).slice(0, 128),
      })
      .where(
        and(
          eq(pendingScoutEmissions.organizationId, source.organizationId),
          eq(pendingScoutEmissions.sourceKind, source.sourceKind),
          eq(pendingScoutEmissions.sourceId, source.sourceId),
          lte(pendingScoutEmissions.nextAttemptAt, sql`${now}::timestamptz`),
        ),
      );
    observeFailure(recovery.error, {
      sink: SCOUT_EMISSION_FAILURE,
      ctx: { organizationId: source.organizationId, source: source.sourceKind },
    });
  }
};
