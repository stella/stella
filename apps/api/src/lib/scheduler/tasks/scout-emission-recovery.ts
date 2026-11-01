import { panic, Result } from "better-result";
import { and, asc, eq, getColumns, not, or, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import { proveOrgScope, withOrgScope } from "@/api/db/org-scope";
import type { OrgScope } from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import {
  documentReviewRuns,
  entities,
  pendingScoutEmissions,
} from "@/api/db/schema";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
import { transitionRecoveryGrantState } from "@/api/lib/db/recovery-bookkeeping/grant-state";
import { mutateRecoveryReceipt } from "@/api/lib/db/recovery-bookkeeping/receipts";
import {
  type TimestampCasToken,
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  backgroundFeatureActorExists,
  findSignalsBackgroundActor,
} from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  brandPersistedDocumentReviewRunId,
  brandPersistedEntityId,
} from "@/api/lib/safe-id-boundaries";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type {
  SchedulerDb,
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { emitDocumentReviewSignal } from "@/api/lib/scouts/document-review";
import { emitInfoSoudHearingSignals } from "@/api/lib/scouts/infosoud-hearings";
import { toHearingRecord } from "@/api/lib/scouts/infosoud-hearings.logic";

import {
  checkpointRecoveryScan,
  readRecoveryScanState,
  scoutRecoveryCursorFor,
} from "./recovery-scan-cursor";
import type {
  ScoutRecoveryCursor,
  ScoutRecoveryState,
} from "./recovery-scan-cursor";
import {
  RECOVERY_SCAN_IDENTITIES,
  RECOVERY_SCAN_PAGE_SIZES,
  RECOVERY_SCAN_PHASES,
} from "./recovery-scan-identity";

export const RECOVER_SCOUT_EMISSION_TASK = RECOVERY_SCAN_IDENTITIES.scout.task;
export const SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS = 5000;
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
      panic("Blocking aggregate acquisition returned busy");
    }
  }
};

type ClaimScoutReceiptOptions = {
  tx: Transaction;
  scope: OrgScope;
  source: Omit<typeof pendingScoutEmissions.$inferSelect, "nextAttemptAt"> & {
    nextAttemptAt: TimestampCasToken;
  };
  now: Date;
};

const claimScoutReceipt = async ({
  tx,
  scope,
  source,
  now,
}: ClaimScoutReceiptOptions) => {
  const sourceWhere = and(
    eq(pendingScoutEmissions.organizationId, source.organizationId),
    eq(pendingScoutEmissions.sourceKind, source.sourceKind),
    eq(pendingScoutEmissions.sourceId, source.sourceId),
  );
  // A blocked recipient must not starve the rest of the bounded page.
  const claimedAt = new Date(now.getTime() + RETRY_INTERVAL_MS);
  const claimed = await mutateRecoveryClaim({
    type: "scout-claim",
    tx,
    scope,
    nextAttemptAt: claimedAt,
    where: sql`${and(
      sourceWhere,
      eq(pendingScoutEmissions.status, "pending"),
      timestampMatchesCasToken(
        pendingScoutEmissions.nextAttemptAt,
        source.nextAttemptAt,
      ),
      scoutEmissionActorExists(),
    )}`,
  });
  const claim = claimed.at(0);
  return claim === undefined
    ? undefined
    : { sourceWhere, claimToken: claim.claimToken };
};

type EmitClaimedScoutReceiptOptions = {
  tx: Transaction;
  scope: OrgScope;
  source: ClaimScoutReceiptOptions["source"];
  now: Date;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  logger: SchedulerTaskContext["logger"];
};

const emitClaimedScoutReceipt = async ({
  tx,
  scope,
  source,
  now,
  workspaceId,
  organizationId,
  logger,
}: EmitClaimedScoutReceiptOptions) => {
  const claim = await claimScoutReceipt({
    tx,
    scope,
    source,
    now,
  });
  if (claim === undefined) {
    return { status: "stale" as const };
  }
  switch (source.sourceKind) {
    case "document-review": {
      if (!isDeploymentFeatureEnabled("FEATURE_INBOX_DOCUMENT_SCOUTS")) {
        return { status: "paused" as const };
      }
      const outcome = await emitDocumentReviewSignal({
        tx,
        workspaceId,
        runId: brandPersistedDocumentReviewRunId(source.sourceId),
      });
      if (outcome === "paused") {
        logger.info("scout.emission_paused", {
          sourceKind: source.sourceKind,
        });
        return { status: "paused" as const };
      }
      break;
    }
    case "infosoud-hearing": {
      if (
        (await findSignalsBackgroundActor({
          tx,
          organizationId,
          workspaceId,
        })) === null
      ) {
        logger.info("scout.emission_paused", {
          sourceKind: source.sourceKind,
        });
        return { status: "paused" as const };
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
              eq(entities.workspaceId, workspaceId),
              eq(entities.externalSource, "infosoud"),
            ),
          )
          .limit(1)
      ).at(0);
      const hearing = entity ? toHearingRecord(entity) : null;
      if (hearing) {
        await emitInfoSoudHearingSignals({
          tx,
          organizationId,
          workspaceId,
          inserted: [{ entityId, hearing }],
          now,
        });
        // Recovery owns this claimed receipt; the producer only settles receipts it inserted.
      }
      break;
    }
    default:
      source.sourceKind satisfies never;
      panic("Unknown deferred scout source");
  }
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return { status: "paused" as const };
  }
  const removed = await mutateRecoveryReceipt({
    type: "settle-scout",
    tx,
    scope,
    where: sql`${and(
      claim.sourceWhere,
      eq(pendingScoutEmissions.status, "pending"),
      timestampMatchesCasToken(
        pendingScoutEmissions.nextAttemptAt,
        claim.claimToken,
      ),
      scoutEmissionActorExists(),
    )}`,
  });
  return {
    status: removed.length === 0 ? ("stale" as const) : ("settled" as const),
  };
};

const afterScoutRecoveryCursor = (cursor: ScoutRecoveryCursor | null) =>
  cursor === null
    ? undefined
    : sql`(${pendingScoutEmissions.organizationId}, ${pendingScoutEmissions.sourceKind}, ${pendingScoutEmissions.sourceId}) > (${cursor.organizationId}, ${cursor.sourceKind}, ${cursor.sourceId})`;

type ReadScoutRecoveryDispatchPageOptions = {
  db: SchedulerDb;
  cursor: ScoutRecoveryCursor | null;
  now: Date;
};

const readScoutRecoveryDispatchPage = async ({
  db,
  cursor,
  now,
}: ReadScoutRecoveryDispatchPageOptions) =>
  await withAggregateTransaction(db, async (tx) => {
    await setSharedStatementTimeout(
      tx,
      SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS,
    );
    return await readCursorPage(
      tx
        .select({
          ...getColumns(pendingScoutEmissions),
          nextAttemptAt: timestampCasToken(pendingScoutEmissions.nextAttemptAt),
          actorEligible: scoutEmissionActorExists(),
          due: sql<boolean>`${pendingScoutEmissions.nextAttemptAt} <= ${now}::timestamptz`,
        })
        .from(pendingScoutEmissions)
        .where(afterScoutRecoveryCursor(cursor))
        .orderBy(
          asc(pendingScoutEmissions.organizationId),
          asc(pendingScoutEmissions.sourceKind),
          asc(pendingScoutEmissions.sourceId),
        ),
      {
        limit: RECOVERY_SCAN_PAGE_SIZES.dispatch,
        cursorForItem: (row) =>
          `${row.organizationId}:${row.sourceKind}:${row.sourceId}`,
      },
    );
  });

type ScoutRecoveryCensusOptions = {
  db: SchedulerDb;
  job: SchedulerTaskContext["job"];
  scan: ScoutRecoveryState;
  now: Date;
  scheduleContinuation: SchedulerTaskContext["scheduleContinuation"];
};

const runScoutRecoveryCensus = async ({
  db,
  job,
  scan,
  now,
  scheduleContinuation,
}: ScoutRecoveryCensusOptions) => {
  const census = await reconcileScoutEmissionGrantState({
    database: db,
    cursor: scan.census,
  });
  const state = {
    phase: RECOVERY_SCAN_PHASES.dispatch,
    census: census.cursor,
    dispatch: scan.dispatch,
  };
  const saved = await checkpointRecoveryScan({
    database: db,
    job,
    statementTimeoutMs: SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS,
    state: { type: "scout", value: state },
  });
  if (saved) {
    scheduleContinuation(new Date(now.getTime() + 1000));
  }
};

/** Admission pauses retain source identities; emission and dequeue commit together. */
const runScoutEmissionRecovery = async ({
  db,
  dueAt,
  job,
  payload,
  scheduleContinuation,
  signal,
  logger,
}: SchedulerTaskContext) => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return;
  }
  const now = dueAt.claimedAtDate();
  const cursorState = readRecoveryScanState(job, payload);
  if (cursorState.type !== "scout") {
    panic("Scout recovery received an upload cursor state");
  }
  const scan = cursorState.value;
  switch (scan.phase) {
    case RECOVERY_SCAN_PHASES.census:
      await runScoutRecoveryCensus({
        db,
        job,
        scan,
        now,
        scheduleContinuation,
      });
      return;
    case RECOVERY_SCAN_PHASES.dispatch:
      break;
    default:
      scan.phase satisfies never;
      panic("Unknown scout recovery phase");
  }
  const dispatchPage = await readScoutRecoveryDispatchPage({
    db,
    cursor: scan.dispatch,
    now,
  });
  const pending = dispatchPage.items.filter(
    (row) => row.status === "pending" && row.due && row.actorEligible,
  );
  for (const source of pending) {
    signal.throwIfAborted();
    const recovery = await Result.tryPromise(async () =>
      withAggregateTransaction(db, async (tx) => {
        await setSharedStatementTimeout(
          tx,
          SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS,
        );
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId: source.organizationId,
          featureId: "signals",
        });
        if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
          return { status: "paused" as const };
        }
        await lockScoutReceiptRows(tx, [source]);
        const proof = await proveOrgScope(tx, {
          table: "pendingScoutEmissions",
          where: sql`${and(
            eq(pendingScoutEmissions.organizationId, source.organizationId),
            eq(pendingScoutEmissions.sourceKind, source.sourceKind),
            eq(pendingScoutEmissions.sourceId, source.sourceId),
            eq(pendingScoutEmissions.status, "pending"),
            timestampMatchesCasToken(
              pendingScoutEmissions.nextAttemptAt,
              source.nextAttemptAt,
            ),
            scoutEmissionActorExists(),
          )}`,
        });
        if (proof.isErr()) {
          return { status: "stale" as const };
        }
        const workspaceId =
          proof.value.workspaceIds.at(0) ??
          panic("Scout receipt requires a matter");
        return await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) =>
            await emitClaimedScoutReceipt({
              tx: scopedTx,
              scope: proof.value,
              source,
              now,
              workspaceId,
              organizationId: proof.value.organizationId,
              logger,
            }),
        });
      }),
    );
    if (Result.isOk(recovery)) {
      continue;
    }
    if (isPgError(recovery.error, PG_ERROR.QUERY_CANCELED)) {
      throw new SchedulerTaskFailure({
        message: "Scout emission recovery timed out",
        cause: recovery.error,
      });
    }
    // db-await-in-loop: retry the failed source independently after its emission transaction rolled back
    await withAggregateTransaction(db, async (tx) => {
      await setSharedStatementTimeout(
        tx,
        SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS,
      );
      await lockFeatureRecoveryAdmission({
        tx,
        organizationId: source.organizationId,
        featureId: "signals",
      });
      if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
        return;
      }
      await lockScoutReceiptRows(tx, [source]);
      const proof = await proveOrgScope(tx, {
        table: "pendingScoutEmissions",
        where: sql`${and(
          eq(pendingScoutEmissions.organizationId, source.organizationId),
          eq(pendingScoutEmissions.sourceKind, source.sourceKind),
          eq(pendingScoutEmissions.sourceId, source.sourceId),
          eq(pendingScoutEmissions.status, "pending"),
          timestampMatchesCasToken(
            pendingScoutEmissions.nextAttemptAt,
            source.nextAttemptAt,
          ),
          scoutEmissionActorExists(),
        )}`,
      });
      if (proof.isErr()) {
        return;
      }
      await withOrgScope({
        tx,
        scope: proof.value,
        actor: { type: "system" },
        fn: async (scopedTx) => {
          await mutateRecoveryClaim({
            type: "scout-retry",
            tx: scopedTx,
            scope: proof.value,
            nextAttemptAt: new Date(now.getTime() + RETRY_INTERVAL_MS),
            lastError: errorTag(recovery.error.cause).slice(0, 128),
            where: sql`${and(
              eq(
                pendingScoutEmissions.organizationId,
                proof.value.organizationId,
              ),
              eq(pendingScoutEmissions.sourceKind, source.sourceKind),
              eq(pendingScoutEmissions.sourceId, source.sourceId),
              eq(pendingScoutEmissions.status, "pending"),
              timestampMatchesCasToken(
                pendingScoutEmissions.nextAttemptAt,
                source.nextAttemptAt,
              ),
              scoutEmissionActorExists(),
            )}`,
          });
        },
      });
    });
    observeFailure(recovery.error, {
      sink: SCOUT_EMISSION_FAILURE,
      ctx: { organizationId: source.organizationId, source: source.sourceKind },
    });
  }
  const last = dispatchPage.items.at(-1);
  const state = {
    phase: RECOVERY_SCAN_PHASES.census,
    census: scan.census,
    dispatch:
      dispatchPage.nextCursor === null || last === undefined
        ? null
        : scoutRecoveryCursorFor(last),
  };
  const saved = await checkpointRecoveryScan({
    database: db,
    job,
    statementTimeoutMs: SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS,
    state: { type: "scout", value: state },
  });
  if (!saved) {
    return;
  }
  if (
    state.census !== null ||
    dispatchPage.nextCursor !== null ||
    pending.length > 0
  ) {
    scheduleContinuation(new Date(now.getTime() + 1000));
  }
};

const scoutEmissionActorExists = (userId?: SafeId<"user">) => sql<boolean>`CASE
  WHEN ${pendingScoutEmissions.sourceKind} = 'document-review' THEN
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM ${documentReviewRuns}
      WHERE ${documentReviewRuns.id} = ${pendingScoutEmissions.sourceId}
        AND ${documentReviewRuns.workspaceId} = ${pendingScoutEmissions.workspaceId}
        AND ${documentReviewRuns.organizationId} = ${pendingScoutEmissions.organizationId}
    ) THEN ${userId === undefined} ELSE EXISTS (
      SELECT 1 FROM ${documentReviewRuns}
      WHERE ${documentReviewRuns.id} = ${pendingScoutEmissions.sourceId}
        AND ${documentReviewRuns.workspaceId} = ${pendingScoutEmissions.workspaceId}
        AND ${documentReviewRuns.organizationId} = ${pendingScoutEmissions.organizationId}
        AND ${userId === undefined ? sql`true` : sql`${documentReviewRuns.requestedBy} = ${userId}`}
        AND ${backgroundFeatureActorExists({ organizationId: pendingScoutEmissions.organizationId, workspaceId: pendingScoutEmissions.workspaceId, featureId: "signals", userId: documentReviewRuns.requestedBy })}
    ) END
  ELSE ${backgroundFeatureActorExists({ organizationId: pendingScoutEmissions.organizationId, workspaceId: pendingScoutEmissions.workspaceId, featureId: "signals", ...(userId === undefined ? {} : { userId }) })}
END`;

export const recoverScoutEmission: SchedulerTask = async (context) => {
  const outcome = await Result.tryPromise({
    try: async () => await runScoutEmissionRecovery(context),
    catch: (cause) =>
      cause instanceof SchedulerTaskFailure
        ? cause
        : new SchedulerTaskFailure({
            message: "Scout emission recovery failed",
            cause,
          }),
  });
  if (outcome.isErr()) {
    return outcome;
  }
  return undefined;
};

type ResumeScoutEmissionAfterGrantOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** Caller holds the organization admission lock; no source data escapes the owner. */
export const resumeScoutEmissionAfterGrant = async ({
  tx,
  organizationId,
  userId,
}: ResumeScoutEmissionAfterGrantOptions): Promise<void> => {
  const page = await readCursorPage(
    tx
      .select({
        ...getColumns(pendingScoutEmissions),
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
      .orderBy(
        pendingScoutEmissions.sourceKind,
        pendingScoutEmissions.sourceId,
      ),
    { limit: RECOVERY_PAGE_SIZE, cursorForItem: (row) => row.sourceId },
  );
  const rows = page.items;
  if (rows.length === 0 || !isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return;
  }
  await lockScoutReceiptRows(tx, rows);
  await mapWithConcurrency({
    items: rows,
    limit: 1,
    operation: async (row) => {
      const proof = await proveOrgScope(tx, {
        table: "pendingScoutEmissions",
        where: sql`${and(
          eq(pendingScoutEmissions.organizationId, organizationId),
          eq(pendingScoutEmissions.sourceKind, row.sourceKind),
          eq(pendingScoutEmissions.sourceId, row.sourceId),
          eq(pendingScoutEmissions.status, "awaiting_grant"),
          timestampMatchesCasToken(
            pendingScoutEmissions.nextAttemptAt,
            row.nextAttemptAt,
          ),
          scoutEmissionActorExists(userId),
        )}`,
      });
      if (proof.isErr()) {
        return;
      }
      await withOrgScope({
        tx,
        scope: proof.value,
        actor: { type: "system" },
        fn: async (_scopedTx, grantScope) =>
          await transitionRecoveryGrantState({
            type: "scout",
            tx: grantScope,
            where: sql`${and(
              eq(
                pendingScoutEmissions.organizationId,
                proof.value.organizationId,
              ),
              eq(pendingScoutEmissions.sourceKind, row.sourceKind),
              eq(pendingScoutEmissions.sourceId, row.sourceId),
              timestampMatchesCasToken(
                pendingScoutEmissions.nextAttemptAt,
                row.nextAttemptAt,
              ),
              scoutEmissionActorExists(userId),
            )}`,
            options: { from: ["awaiting_grant"], to: "pending" },
            log: { event: "scout.emission_grant_resumed" },
          }),
      });
    },
  });
};

type ReconcileScoutEmissionGrantStateOptions = {
  database: SchedulerDb;
  cursor: ScoutRecoveryCursor | null;
};

/** Only changed rows from the bounded primary-key page enter the existing locked repair path. */
const reconcileScoutEmissionGrantState = async ({
  database,
  cursor,
}: ReconcileScoutEmissionGrantStateOptions) => {
  const page = await withAggregateTransaction(database, async (tx) => {
    await setSharedStatementTimeout(
      tx,
      SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS,
    );
    return await readCursorPage(
      tx
        .select({
          ...getColumns(pendingScoutEmissions),
          nextAttemptAt: timestampCasToken(pendingScoutEmissions.nextAttemptAt),
          actorEligible: scoutEmissionActorExists(),
        })
        .from(pendingScoutEmissions)
        .where(afterScoutRecoveryCursor(cursor))
        .orderBy(
          asc(pendingScoutEmissions.organizationId),
          asc(pendingScoutEmissions.sourceKind),
          asc(pendingScoutEmissions.sourceId),
        ),
      {
        limit: RECOVERY_SCAN_PAGE_SIZES.census,
        cursorForItem: (row) =>
          `${row.organizationId}:${row.sourceKind}:${row.sourceId}`,
      },
    );
  });
  const candidates = page.items.filter(
    (row) =>
      (row.status === "awaiting_grant" && row.actorEligible) ||
      (row.status === "pending" && !row.actorEligible),
  );
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
        await setSharedStatementTimeout(
          tx,
          SCOUT_EMISSION_RECOVERY_STATEMENT_TIMEOUT_MS,
        );
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "signals",
        });
        if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
          return;
        }
        await lockScoutReceiptRows(tx, rows);
        await mapWithConcurrency({
          items: rows,
          limit: 1,
          operation: async (row) => {
            const proof = await proveOrgScope(tx, {
              table: "pendingScoutEmissions",
              where: sql`${and(
                eq(pendingScoutEmissions.organizationId, organizationId),
                eq(pendingScoutEmissions.sourceKind, row.sourceKind),
                eq(pendingScoutEmissions.sourceId, row.sourceId),
                timestampMatchesCasToken(
                  pendingScoutEmissions.nextAttemptAt,
                  row.nextAttemptAt,
                ),
                or(
                  eq(pendingScoutEmissions.status, "pending"),
                  eq(pendingScoutEmissions.status, "awaiting_grant"),
                ),
              )}`,
            });
            if (proof.isErr()) {
              return;
            }
            await withOrgScope({
              tx,
              scope: proof.value,
              actor: { type: "system" },
              fn: async (_scopedTx, grantScope) => {
                const identity = and(
                  eq(
                    pendingScoutEmissions.organizationId,
                    proof.value.organizationId,
                  ),
                  eq(pendingScoutEmissions.sourceKind, row.sourceKind),
                  eq(pendingScoutEmissions.sourceId, row.sourceId),
                  timestampMatchesCasToken(
                    pendingScoutEmissions.nextAttemptAt,
                    row.nextAttemptAt,
                  ),
                );
                await transitionRecoveryGrantState({
                  type: "scout",
                  tx: grantScope,
                  where: sql`${and(identity, not(scoutEmissionActorExists()))}`,
                  options: { from: ["pending"], to: "awaiting_grant" },
                  log: { event: "scout.emission_awaiting_grant" },
                });
                await transitionRecoveryGrantState({
                  type: "scout",
                  tx: grantScope,
                  where: sql`${and(identity, scoutEmissionActorExists())}`,
                  options: { from: ["awaiting_grant"], to: "pending" },
                  log: { event: "scout.emission_grant_repaired" },
                });
              },
            });
          },
        });
      }),
  });
  const last = page.items.at(-1);
  return {
    hasMore: page.nextCursor !== null,
    cursor:
      page.nextCursor === null || last === undefined
        ? null
        : scoutRecoveryCursorFor(last),
  };
};
