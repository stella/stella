import { panic, Result } from "better-result";
import { and, asc, eq, inArray, lt, not, or, sql } from "drizzle-orm";

import { SCOUT_KEY } from "@stll/api-contract/signals";
import { mapWithConcurrency } from "@stll/concurrency";
import { Temporal } from "@stll/time";

import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  SCOUT_RUN_STATUS,
  scoutRuns,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
import { transitionRecoveryGrantState } from "@/api/lib/db/recovery-bookkeeping/grant-state";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { defineScopedTransitions } from "@/api/lib/db/transitions";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { enqueueDocumentDeadlineScout } from "@/api/lib/document-processing-enqueue";
import {
  cappedSelectionHasMore,
  RECONCILE_BATCH_SIZE,
} from "@/api/lib/document-processing-reconciliation-progress";
import type { ReconciliationPhaseResult } from "@/api/lib/document-processing-reconciliation-progress";
import { backgroundFeatureActorExists } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { logger } from "@/api/lib/observability/logger";
import { deadlineScoutDue } from "@/api/lib/scouts/document-deadline-skip";

const DEADLINE_SCOUT_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const DEADLINE_SCOUT_DISPATCH_CONCURRENCY = 4;

// Recovery owns lease retirement and recoverable admission parking.
export const DEADLINE_DISPATCH_RECOVERY = defineScopedTransitions({
  table: documentProcessingRuns,
  key: "id",
  scope: [],
  stateColumn: "deadlineScoutStatus",
  edges: {
    not_requested: [],
    pending: ["awaiting_grant", "running"],
    awaiting_grant: ["pending"],
    running: ["pending", "awaiting_grant", "succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  },
  initial: [],
});

const DEADLINE_CENSUS_RECOVERY = defineScopedTransitions({
  table: scoutRuns,
  key: "id",
  scope: [],
  stateColumn: "status",
  edges: {
    running: ["failed"],
    succeeded: [],
    failed: [],
  },
  initial: [],
});

export type DeadlineDispatchRecoverySpec = typeof DEADLINE_DISPATCH_RECOVERY;
export type DeadlineCensusRecoverySpec = typeof DEADLINE_CENSUS_RECOVERY;

const deadlineMatterAdmission = (userId?: SafeId<"user">) =>
  backgroundFeatureActorExists({
    organizationId: documentProcessingRuns.organizationId,
    workspaceId: documentProcessingRuns.workspaceId,
    featureId: "signals",
    ...(userId === undefined ? {} : { userId }),
  });

type ResumeDocumentDeadlineScoutsOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** The grant writer holds the organization admission lock before insertion and this resume. */
export const resumeDocumentDeadlineScoutsAfterGrant = async ({
  tx,
  organizationId,
  userId,
}: ResumeDocumentDeadlineScoutsOptions): Promise<void> => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return;
  }
  // Resumed rows leave the awaiting index; later calls advance through the
  // ordered identity page while periodic repair owns any remaining backlog.
  const rows = (
    await readCursorPage(
      tx
        .select({ id: documentProcessingRuns.id })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.organizationId, organizationId),
            eq(documentProcessingRuns.deadlineScoutStatus, "awaiting_grant"),
            deadlineMatterAdmission(userId),
          ),
        )
        .orderBy(asc(documentProcessingRuns.id)),
      { limit: RECONCILE_BATCH_SIZE, cursorForItem: (row) => row.id },
    )
  ).items;
  if (rows.length === 0) {
    return;
  }
  await transitionRecoveryGrantState({
    type: "deadline",
    tx,
    table: documentProcessingRuns,
    spec: DEADLINE_DISPATCH_RECOVERY,
    where: sql`${and(
      eq(documentProcessingRuns.organizationId, organizationId),
      inArray(
        documentProcessingRuns.id,
        rows.map((row) => row.id),
      ),
      deadlineMatterAdmission(userId),
    )}`,
    options: {
      from: ["awaiting_grant"],
      to: "pending",
      set: { deadlineScoutErrorCode: null, updatedAt: new Date() },
    },
    log: { event: "scout.document_deadlines.grant_resumed" },
  });
};

export type DeadlineScoutClaimSettlement =
  | { status: "settled" }
  | { status: "stale_claim" };

type PauseDocumentDeadlineScoutOptions = {
  database: Pick<typeof rootDb, "select" | "transaction">;
  sourceRunId: SafeId<"documentProcessingRun">;
} & (
  | { from: "pending" }
  | { from: "running"; claimedAtToken: TimestampCasToken }
);

/** The same lock as grant insertion closes check-then-park and regrant ordering races. */
export const pauseDocumentDeadlineScoutAfterGrantLoss = async ({
  database,
  sourceRunId,
  ...claim
}: PauseDocumentDeadlineScoutOptions): Promise<DeadlineScoutClaimSettlement> => {
  const source = (
    await database
      .select({ organizationId: documentProcessingRuns.organizationId })
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, sourceRunId))
      .limit(1)
  ).at(0);
  if (!source) {
    return { status: "stale_claim" };
  }
  return await withAggregateTransaction(database, async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: source.organizationId,
      featureId: "signals",
    });
    const metadata = {
      deadlineScoutClaimedAt: null,
      deadlineScoutErrorCode: "feature_not_granted",
      updatedAt: new Date(),
    };
    const parked = isDeploymentFeatureEnabled("FEATURE_SIGNALS")
      ? await transitionRecoveryGrantState({
          type: "deadline",
          tx,
          table: documentProcessingRuns,
          spec: DEADLINE_DISPATCH_RECOVERY,
          where: sql`${and(eq(documentProcessingRuns.id, sourceRunId), claim.from === "running" ? timestampMatchesCasToken(documentProcessingRuns.deadlineScoutClaimedAt, claim.claimedAtToken) : undefined, not(deadlineMatterAdmission()))}`,
          options: { from: [claim.from], to: "awaiting_grant", set: metadata },
          log: { event: "scout.document_deadlines.grant_paused" },
          attemptRefund: claim.from === "running" ? 1 : 0,
        })
      : 0;
    if (parked !== 0) {
      return { status: "settled" };
    }
    if (claim.from === "pending") {
      return { status: "stale_claim" };
    }
    // A grant that committed before the lock keeps the rejected observation retryable under a new actor.
    const retried = await transitionRecoveryGrantState({
      type: "deadline",
      tx,
      table: documentProcessingRuns,
      spec: DEADLINE_DISPATCH_RECOVERY,
      where: sql`${and(eq(documentProcessingRuns.id, sourceRunId), timestampMatchesCasToken(documentProcessingRuns.deadlineScoutClaimedAt, claim.claimedAtToken))}`,
      options: { from: ["running"], to: "pending", set: metadata },
      log: { event: "scout.document_deadlines.admission_retry" },
      attemptRefund: 1,
    });
    return { status: retried === 0 ? "stale_claim" : "settled" };
  });
};

type ReconcileDeadlineAdmissionOptions = {
  database: typeof rootDb;
  direction: "pause" | "resume";
};

const reconcileDeadlineAdmission = async ({
  database,
  direction,
}: ReconcileDeadlineAdmissionOptions) => {
  const admission =
    direction === "pause"
      ? not(deadlineMatterAdmission())
      : deadlineMatterAdmission();
  const sourceStatus = direction === "pause" ? "pending" : "awaiting_grant";
  const transition =
    direction === "pause"
      ? ({
          from: ["pending"],
          to: "awaiting_grant",
          set: {
            deadlineScoutClaimedAt: null,
            deadlineScoutErrorCode: "feature_not_granted",
            updatedAt: new Date(),
          },
        } as const)
      : ({
          from: ["awaiting_grant"],
          to: "pending",
          set: { deadlineScoutErrorCode: null, updatedAt: new Date() },
        } as const);
  const candidates = (
    await readCursorPage(
      database
        .select({
          id: documentProcessingRuns.id,
          organizationId: documentProcessingRuns.organizationId,
        })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.deadlineScoutStatus, sourceStatus),
            admission,
          ),
        )
        .orderBy(
          asc(documentProcessingRuns.updatedAt),
          asc(documentProcessingRuns.id),
        ),
      { limit: RECONCILE_BATCH_SIZE, cursorForItem: (row) => row.id },
    )
  ).items;
  const organizations = new Map<
    SafeId<"organization">,
    SafeId<"documentProcessingRun">[]
  >();
  for (const row of candidates) {
    const ids = organizations.get(row.organizationId);
    if (ids) {
      ids.push(row.id);
    } else {
      organizations.set(row.organizationId, [row.id]);
    }
  }
  const counts = await mapWithConcurrency({
    items: [...organizations],
    limit: DEADLINE_SCOUT_DISPATCH_CONCURRENCY,
    operation: async ([organizationId, ids]) =>
      await withAggregateTransaction(database, async (tx) => {
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "signals",
        });
        return await transitionRecoveryGrantState({
          type: "deadline",
          tx,
          table: documentProcessingRuns,
          spec: DEADLINE_DISPATCH_RECOVERY,
          where: sql`${and(inArray(documentProcessingRuns.id, ids), admission)}`,
          options: transition,
          log: {
            event: "scout.document_deadlines.admission_reconciled",
            direction,
          },
        });
      }),
  });
  return {
    count: counts.reduce((total, count) => total + count, 0),
    hasMore: cappedSelectionHasMore({
      limit: RECONCILE_BATCH_SIZE,
      selected: candidates.length,
    }),
  };
};

/** The two dependencies this sweep needs, so the scheduler can run it without
 *  assembling the whole reconciliation set and a test can drive it with a
 *  stubbed queue. */
type RecoverDocumentDeadlineScoutDispatchesOptions = {
  database: typeof rootDb;
  enqueueDocumentDeadlineScout?: typeof enqueueDocumentDeadlineScout;
};

/**
 * Return expired dispatches to pending and enqueue admitted durable sources.
 * Source-run identities deduplicate overlapping dispatches; grant waits stay
 * recorded until admission resumes them.
 */
export const recoverDocumentDeadlineScoutDispatches = async ({
  database,
  enqueueDocumentDeadlineScout: enqueueScout = enqueueDocumentDeadlineScout,
}: RecoverDocumentDeadlineScoutDispatchesOptions): Promise<ReconciliationPhaseResult> => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    logger.info("scout.document_deadlines.recovery_skipped", {
      reason: "deployment_disabled",
    });
    return { count: 0, hasMore: false };
  }
  const staleBefore = new Date(
    Temporal.Now.instant().epochMilliseconds - DEADLINE_SCOUT_LEASE_TIMEOUT_MS,
  );
  const staleDispatches = (
    await readCursorPage(
      database
        .select({
          id: documentProcessingRuns.id,
          claimedAtToken: timestampCasToken(
            documentProcessingRuns.deadlineScoutClaimedAt,
          ),
        })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.deadlineScoutStatus, "running"),
            lt(documentProcessingRuns.deadlineScoutClaimedAt, staleBefore),
          ),
        )
        .orderBy(
          asc(documentProcessingRuns.deadlineScoutClaimedAt),
          asc(documentProcessingRuns.id),
        ),
      { limit: RECONCILE_BATCH_SIZE, cursorForItem: (row) => row.id },
    )
  ).items;
  // Match the expired claim and state again: overlapping sweeps must not
  // retire a fresh claim acquired after selection. A stale update then matches
  // nothing, preserving settlement and preventing a completed scan's replay.
  const reclaimedDispatchCount =
    staleDispatches.length === 0
      ? 0
      : await withAggregateTransaction(
          database,
          async (tx) =>
            await mutateRecoveryClaim({
              type: "deadline-expiry",
              tx,
              table: documentProcessingRuns,
              spec: DEADLINE_DISPATCH_RECOVERY,
              where: sql`${and(
                or(
                  ...staleDispatches.map(({ id, claimedAtToken }) =>
                    and(
                      eq(documentProcessingRuns.id, id),
                      timestampMatchesCasToken(
                        documentProcessingRuns.deadlineScoutClaimedAt,
                        claimedAtToken ??
                          panic("Expired deadline claim has no token"),
                      ),
                    ),
                  ),
                ),
                eq(documentProcessingRuns.deadlineScoutStatus, "running"),
                lt(documentProcessingRuns.deadlineScoutClaimedAt, staleBefore),
              )}`,
              now: new Date(),
            }),
        );

  const staleCensusRuns = (
    await readCursorPage(
      database
        .select({
          id: scoutRuns.id,
          startedAtToken: timestampCasToken(scoutRuns.startedAt),
        })
        .from(scoutRuns)
        .where(
          and(
            eq(scoutRuns.scoutKey, SCOUT_KEY.DOCUMENT_DEADLINES),
            eq(scoutRuns.status, SCOUT_RUN_STATUS.RUNNING),
            lt(scoutRuns.startedAt, staleBefore),
          ),
        )
        .orderBy(asc(scoutRuns.startedAt), asc(scoutRuns.id)),
      { limit: RECONCILE_BATCH_SIZE, cursorForItem: (row) => row.id },
    )
  ).items;
  // Same compare-and-set, so a census run that restarted between the select
  // and this update is not retired out from under its worker.
  const failedCensusCount =
    staleCensusRuns.length === 0
      ? 0
      : await withAggregateTransaction(
          database,
          async (tx) =>
            await mutateRecoveryClaim({
              type: "scout-expiry",
              tx,
              table: scoutRuns,
              spec: DEADLINE_CENSUS_RECOVERY,
              where: sql`${and(
                or(
                  ...staleCensusRuns.map(({ id, startedAtToken }) =>
                    and(
                      eq(scoutRuns.id, id),
                      timestampMatchesCasToken(
                        scoutRuns.startedAt,
                        startedAtToken,
                      ),
                    ),
                  ),
                ),
                eq(scoutRuns.status, SCOUT_RUN_STATUS.RUNNING),
                lt(scoutRuns.startedAt, staleBefore),
              )}`,
              now: new Date(),
            }),
        );

  const parked = await reconcileDeadlineAdmission({
    database,
    direction: "pause",
  });
  // Admission-filtered repair recovers a committed grant whose post-commit hook never ran.
  const resumed = await reconcileDeadlineAdmission({
    database,
    direction: "resume",
  });

  const pending = (
    await readCursorPage(
      database
        .select({ sourceRunId: documentProcessingRuns.id })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.deadlineScoutStatus, "pending"),
            deadlineMatterAdmission(),
            deadlineScoutDue(new Date()),
          ),
        )
        .orderBy(
          asc(documentProcessingRuns.updatedAt),
          asc(documentProcessingRuns.id),
        ),
      { limit: RECONCILE_BATCH_SIZE, cursorForItem: (row) => row.id },
    )
  ).items;

  const results = await mapWithConcurrency({
    items: pending,
    limit: DEADLINE_SCOUT_DISPATCH_CONCURRENCY,
    operation: async ({ sourceRunId }) =>
      await Result.tryPromise(async () => {
        await enqueueScout({ sourceRunId });
      }),
  });
  for (const result of results) {
    if (Result.isError(result)) {
      captureError(result.error, { operation: "deadline-scout-dispatch" });
    }
  }

  return {
    // Rows actually transitioned, not rows selected: a candidate another
    // sweep already reclaimed is not this sweep's effect.
    count:
      parked.count +
      resumed.count +
      reclaimedDispatchCount +
      failedCensusCount +
      results.filter(Result.isOk).length,
    hasMore:
      parked.hasMore ||
      resumed.hasMore ||
      cappedSelectionHasMore({
        limit: RECONCILE_BATCH_SIZE,
        selected: pending.length,
      }) ||
      cappedSelectionHasMore({
        limit: RECONCILE_BATCH_SIZE,
        selected: staleDispatches.length,
      }) ||
      cappedSelectionHasMore({
        limit: RECONCILE_BATCH_SIZE,
        selected: staleCensusRuns.length,
      }),
  };
};
