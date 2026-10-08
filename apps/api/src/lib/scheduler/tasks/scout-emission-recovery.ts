import { panic, Result } from "better-result";
import { and, asc, eq, getTableColumns, lte, not, or, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewRuns,
  entities,
  pendingScoutEmissions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import {
  timestampCasToken,
  timestampMatchesCasToken,
  type TimestampCasToken,
} from "@/api/lib/db/timestamp-cas";
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

type ScoutReceiptIdentity = Pick<
  typeof pendingScoutEmissions.$inferSelect,
  "organizationId" | "sourceKind" | "sourceId"
>;

const lockScoutReceiptRows = async (
  tx: Pick<Transaction, "execute">,
  rows: readonly ScoutReceiptIdentity[],
): Promise<void> => {
  const ordered = rows.toSorted((left, right) => {
    const leftKey = JSON.stringify([
      left.organizationId,
      left.sourceKind,
      left.sourceId,
    ]);
    const rightKey = JSON.stringify([
      right.organizationId,
      right.sourceKind,
      right.sourceId,
    ]);
    if (leftKey === rightKey) {
      return 0;
    }
    return leftKey < rightKey ? -1 : 1;
  });
  for (const row of ordered) {
    // db-await-in-loop: acquire every processed receipt in the owner's physical composite-key order before mutation.
    const acquired = await withAggregateLock({
      tx,
      aggregate: "scoutCensus",
      id: {
        type: "receipt",
        organizationId: row.organizationId,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
      },
      mode: "update",
    });
    if (acquired.status === "busy") {
      throw acquired.error;
    }
  }
};

type ClaimScoutReceiptOptions = {
  tx: Transaction;
  source: Omit<typeof pendingScoutEmissions.$inferSelect, "nextAttemptAt"> & {
    nextAttemptAt: TimestampCasToken;
  };
  now: Date;
};

const claimScoutReceipt = async ({
  tx,
  source,
  now,
}: ClaimScoutReceiptOptions) => {
  const sourceWhere = and(
    eq(pendingScoutEmissions.organizationId, source.organizationId),
    eq(pendingScoutEmissions.sourceKind, source.sourceKind),
    eq(pendingScoutEmissions.sourceId, source.sourceId),
  );
  // A blocked recipient must not starve the rest of the bounded page.
  // audit: skip — retry bookkeeping on a durable source intent; scheduler_job_runs records attempts.
  const claimedAt = new Date(now.getTime() + RETRY_INTERVAL_MS);
  const claimed = await tx
    .update(pendingScoutEmissions)
    .set({ nextAttemptAt: claimedAt })
    .where(
      and(
        sourceWhere,
        eq(pendingScoutEmissions.status, "pending"),
        timestampMatchesCasToken(
          pendingScoutEmissions.nextAttemptAt,
          source.nextAttemptAt,
        ),
        scoutEmissionActorExists(),
      ),
    )
    .returning({
      sourceId: pendingScoutEmissions.sourceId,
      claimToken: timestampCasToken(pendingScoutEmissions.nextAttemptAt),
    });
  const claim = claimed.at(0);
  return claim === undefined
    ? undefined
    : { sourceWhere, claimToken: claim.claimToken };
};

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
  await reconcileScoutEmissionGrantState({ database: db });
  const pending = (
    await readCursorPage(
      db
        .select({
          ...getTableColumns(pendingScoutEmissions),
          nextAttemptAt: timestampCasToken(pendingScoutEmissions.nextAttemptAt),
        })
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
        ),
      { limit: RECOVERY_PAGE_SIZE, cursorForItem: (row) => row.sourceId },
    )
  ).items;
  for (const source of pending) {
    signal.throwIfAborted();
    // db-await-in-loop: bounded source page; independent atomic tenant emission and dequeue
    const recovery = await Result.tryPromise(() =>
      withAggregateTransaction(db, async (tx) => {
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId: source.organizationId,
          featureId: "signals",
        });
        if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
          return { status: "paused" as const };
        }
        await lockScoutReceiptRows(tx, [source]);
        const claim = await claimScoutReceipt({ tx, source, now });
        if (claim === undefined) {
          return { status: "stale" as const };
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
              // Recovery owns this claimed receipt; the producer only settles receipts it inserted.
            }
            break;
          }
          default:
            source.sourceKind satisfies never;
            return panic("Unknown deferred scout source");
        }
        if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
          return { status: "paused" as const };
        }
        // audit: skip — derived emission intent settled atomically with its audited signal.
        const removed = await tx
          .delete(pendingScoutEmissions)
          .where(
            and(
              claim.sourceWhere,
              eq(pendingScoutEmissions.status, "pending"),
              timestampMatchesCasToken(
                pendingScoutEmissions.nextAttemptAt,
                claim.claimToken,
              ),
              scoutEmissionActorExists(),
            ),
          )
          .returning({ sourceId: pendingScoutEmissions.sourceId });
        return {
          status:
            removed.length === 0 ? ("stale" as const) : ("settled" as const),
        };
      }),
    );
    if (Result.isOk(recovery)) {
      continue;
    }
    // audit: skip — preserves a retryable source and its sanitized failure after emission rolled back.
    // db-await-in-loop: retry the failed source independently after its emission transaction rolled back
    await withAggregateTransaction(db, async (tx) => {
      await lockFeatureRecoveryAdmission({
        tx,
        organizationId: source.organizationId,
        featureId: "signals",
      });
      if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
        return;
      }
      await lockScoutReceiptRows(tx, [source]);
      // audit: skip — rollback left the original token; a newer delivery must win.
      await tx
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
            eq(pendingScoutEmissions.status, "pending"),
            timestampMatchesCasToken(
              pendingScoutEmissions.nextAttemptAt,
              source.nextAttemptAt,
            ),
            scoutEmissionActorExists(),
          ),
        );
    });
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
  ELSE ${backgroundFeatureActorExists({ organizationId: pendingScoutEmissions.organizationId, workspaceId: pendingScoutEmissions.workspaceId, featureId: "signals", ...(userId === undefined ? {} : { userId }) })}
END`;

type ResumeScoutEmissionAfterGrantOptions = {
  tx: Pick<Transaction, "select" | "execute" | "rollback">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** Caller holds the organization admission lock; no source data escapes the owner. */
export const resumeScoutEmissionAfterGrant = async ({
  tx,
  organizationId,
  userId,
}: ResumeScoutEmissionAfterGrantOptions): Promise<void> => {
  const rows = await tx
    .select({
      ...getTableColumns(pendingScoutEmissions),
      nextAttemptAt: timestampCasToken(pendingScoutEmissions.nextAttemptAt),
    })
    .from(pendingScoutEmissions)
    .where(
      and(
        eq(pendingScoutEmissions.organizationId, organizationId),
        eq(pendingScoutEmissions.status, "awaiting_grant"),
        scoutEmissionActorExists(userId),
      ),
    )
    .orderBy(pendingScoutEmissions.sourceKind, pendingScoutEmissions.sourceId)
    .limit(RECOVERY_PAGE_SIZE);
  if (rows.length === 0 || !isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return;
  }
  await lockScoutReceiptRows(tx, rows);
  await transitionScopedCount({
    tx,
    spec: SCOUT_EMISSION_GRANT_TRANSITIONS,
    // sql-perf-allow: bounded by 100 preselected and prelocked exact (organization_id, source_kind, source_id) primary-key identities; actor subqueries only narrow those receipts.
    where: sql`${and(eq(pendingScoutEmissions.organizationId, organizationId), scoutEmissionActorExists(userId), or(...rows.map((row) => and(eq(pendingScoutEmissions.sourceKind, row.sourceKind), eq(pendingScoutEmissions.sourceId, row.sourceId), timestampMatchesCasToken(pendingScoutEmissions.nextAttemptAt, row.nextAttemptAt)))))}`,
    options: {
      from: ["awaiting_grant"],
      to: "pending",
    },
    recordTransitionAuditEvent: (_tx, count) =>
      recoveryLogger.info("scout.emission_grant_resumed", { count }),
  });
};

type ReconcileScoutEmissionGrantStateOptions = {
  database: SchedulerDb;
};

/** The live predicate precedes LIMIT; a paused prefix cannot monopolize dispatch. */
const reconcileScoutEmissionGrantState = async ({
  database,
}: ReconcileScoutEmissionGrantStateOptions) => {
  // Grant repair has its own budget; an older ungranted prefix cannot consume it.
  const resumed = (
    await readCursorPage(
      database
        .select({
          ...getTableColumns(pendingScoutEmissions),
          nextAttemptAt: timestampCasToken(pendingScoutEmissions.nextAttemptAt),
        })
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
        ),
      { limit: RECOVERY_PAGE_SIZE, cursorForItem: (row) => row.sourceId },
    )
  ).items;
  const blocked = (
    await readCursorPage(
      database
        .select({
          ...getTableColumns(pendingScoutEmissions),
          nextAttemptAt: timestampCasToken(pendingScoutEmissions.nextAttemptAt),
        })
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
        ),
      { limit: RECOVERY_PAGE_SIZE, cursorForItem: (row) => row.sourceId },
    )
  ).items;
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
      withAggregateTransaction(database, async (tx) => {
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "signals",
        });
        if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
          return;
        }
        await lockScoutReceiptRows(tx, rows);
        const identities = or(
          ...rows.map((row) =>
            and(
              eq(pendingScoutEmissions.sourceId, row.sourceId),
              eq(pendingScoutEmissions.sourceKind, row.sourceKind),
              timestampMatchesCasToken(
                pendingScoutEmissions.nextAttemptAt,
                row.nextAttemptAt,
              ),
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
          },
          recordTransitionAuditEvent: (_tx, count) =>
            recoveryLogger.info("scout.emission_grant_repaired", { count }),
        });
      }),
  });
};
