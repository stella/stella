import { panic, Result } from "better-result";
import { and, asc, eq, lte, not, or, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import {
  documentReviewRuns,
  entities,
  pendingScoutEmissions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  defineScopedTransitions,
  transitionScopedCount,
} from "@/api/lib/db/transitions";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  backgroundFeatureActorExists,
  findSignalsBackgroundActor,
} from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { failureSink } from "@/api/lib/observability/failure";
import { logger as recoveryLogger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  brandPersistedDocumentReviewRunId,
  brandPersistedEntityId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";
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
  await reconcileScoutEmissionGrantState({ database: db, now });
  const pending = await db
    .select()
    .from(pendingScoutEmissions)
    .where(
      and(
        eq(pendingScoutEmissions.status, "pending"),
        lte(pendingScoutEmissions.nextAttemptAt, sql`${now}::timestamptz`),
        scoutEmissionActorExists(),
      ),
    )
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
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId: source.organizationId,
          featureId: "signals",
        });
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
              eq(pendingScoutEmissions.status, "pending"),
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

const SCOUT_EMISSION_GRANT_TRANSITIONS = defineScopedTransitions({
  table: pendingScoutEmissions,
  key: "sourceId",
  scope: ["organizationId", "sourceKind"],
  stateColumn: "status",
  edges: { pending: ["awaiting_grant"], awaiting_grant: ["pending"] },
  initial: [],
});

const scoutEmissionActorExists = (userId?: SafeId<"user">) => sql`CASE
  WHEN ${pendingScoutEmissions.sourceKind} = 'document-review' THEN
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM ${documentReviewRuns}
      WHERE ${documentReviewRuns.id} = ${pendingScoutEmissions.sourceId}
        AND ${documentReviewRuns.workspaceId} = ${pendingScoutEmissions.workspaceId}
        AND ${documentReviewRuns.organizationId} = ${pendingScoutEmissions.organizationId}
    ) THEN true ELSE EXISTS (
      SELECT 1 FROM ${documentReviewRuns}
      WHERE ${documentReviewRuns.id} = ${pendingScoutEmissions.sourceId}
        AND ${documentReviewRuns.workspaceId} = ${pendingScoutEmissions.workspaceId}
        AND ${documentReviewRuns.organizationId} = ${pendingScoutEmissions.organizationId}
        AND ${userId === undefined ? sql`true` : sql`${documentReviewRuns.requestedBy} = ${userId}`}
        AND ${backgroundFeatureActorExists({ organizationId: pendingScoutEmissions.organizationId, workspaceId: pendingScoutEmissions.workspaceId, featureId: "signals", userId: documentReviewRuns.requestedBy })}
    ) END
  ELSE ${backgroundFeatureActorExists({ organizationId: pendingScoutEmissions.organizationId, workspaceId: pendingScoutEmissions.workspaceId, featureId: "signals", userId })}
END`;

type ResumeScoutEmissionAfterGrantOptions = {
  tx: Pick<SchedulerDb, "select" | "execute">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  now: Date;
};

/** Caller holds the organization admission lock; no source data escapes the owner. */
export const resumeScoutEmissionAfterGrant = async ({
  tx,
  organizationId,
  userId,
  now,
}: ResumeScoutEmissionAfterGrantOptions): Promise<void> => {
  await transitionScopedCount({
    tx,
    spec: SCOUT_EMISSION_GRANT_TRANSITIONS,
    where: sql`${and(eq(pendingScoutEmissions.organizationId, organizationId), eq(pendingScoutEmissions.status, "awaiting_grant"), scoutEmissionActorExists(userId))}`,
    options: {
      from: ["awaiting_grant"],
      to: "pending",
      set: { nextAttemptAt: now },
    },
    recordTransitionAuditEvent: (_tx, count) =>
      recoveryLogger.info("scout.emission_grant_resumed", { count }),
  });
};

type ReconcileScoutEmissionGrantStateOptions = {
  database: SchedulerDb;
  now: Date;
};

/** The live predicate precedes LIMIT; a paused prefix cannot monopolize dispatch. */
const reconcileScoutEmissionGrantState = async ({
  database,
  now,
}: ReconcileScoutEmissionGrantStateOptions) => {
  // Grant repair has its own budget; an older ungranted prefix cannot consume it.
  const resumed = await database
    .select()
    .from(pendingScoutEmissions)
    .where(
      and(
        eq(pendingScoutEmissions.status, "awaiting_grant"),
        scoutEmissionActorExists(),
      ),
    )
    .orderBy(
      asc(pendingScoutEmissions.nextAttemptAt),
      asc(pendingScoutEmissions.sourceId),
    )
    .limit(RECOVERY_PAGE_SIZE);
  const blocked = await database
    .select()
    .from(pendingScoutEmissions)
    .where(
      and(
        eq(pendingScoutEmissions.status, "pending"),
        not(scoutEmissionActorExists()),
      ),
    )
    .orderBy(
      asc(pendingScoutEmissions.nextAttemptAt),
      asc(pendingScoutEmissions.sourceId),
    )
    .limit(RECOVERY_PAGE_SIZE);
  const candidates = [...resumed, ...blocked];
  const groups = new Map<SafeId<"organization">, typeof candidates>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.organizationId);
    if (group === undefined) {
      groups.set(candidate.organizationId, [candidate]);
      continue;
    }
    group.push(candidate);
  }
  await mapWithConcurrency({
    items: [...groups],
    limit: 4,
    operation: async ([organizationId, rows]) =>
      database.transaction(async (tx) => {
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "signals",
        });
        const identities = or(
          ...rows.map((row) =>
            and(
              eq(pendingScoutEmissions.sourceId, row.sourceId),
              eq(pendingScoutEmissions.sourceKind, row.sourceKind),
            ),
          ),
        );
        await transitionScopedCount({
          tx,
          spec: SCOUT_EMISSION_GRANT_TRANSITIONS,
          where: sql`${and(eq(pendingScoutEmissions.organizationId, organizationId), identities, not(scoutEmissionActorExists()))}`,
          options: { from: ["pending"], to: "awaiting_grant" },
          recordTransitionAuditEvent: (_tx, count) =>
            recoveryLogger.info("scout.emission_awaiting_grant", { count }),
        });
        await transitionScopedCount({
          tx,
          spec: SCOUT_EMISSION_GRANT_TRANSITIONS,
          where: sql`${and(eq(pendingScoutEmissions.organizationId, organizationId), identities, scoutEmissionActorExists())}`,
          options: {
            from: ["awaiting_grant"],
            to: "pending",
            set: { nextAttemptAt: now },
          },
          recordTransitionAuditEvent: (_tx, count) =>
            recoveryLogger.info("scout.emission_grant_repaired", { count }),
        });
      }),
  });
};
