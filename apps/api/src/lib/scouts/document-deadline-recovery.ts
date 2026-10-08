import { Result } from "better-result";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";

import { SCOUT_KEY } from "@stll/api-contract/signals";
import { mapWithConcurrency } from "@stll/concurrency";
import { Temporal } from "@stll/time";

import type { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  SCOUT_RUN_STATUS,
  scoutRuns,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import {
  defineScopedTransitions,
  transitionScopedCount,
} from "@/api/lib/db/transitions";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { enqueueDocumentDeadlineScout } from "@/api/lib/document-processing-enqueue";
import {
  cappedSelectionHasMore,
  RECONCILE_BATCH_SIZE,
} from "@/api/lib/document-processing-reconciliation-progress";
import type { ReconciliationPhaseResult } from "@/api/lib/document-processing-reconciliation-progress";
import { logger } from "@/api/lib/observability/logger";
import { deadlineScoutDue } from "@/api/lib/scouts/document-deadline-skip";

const DEADLINE_SCOUT_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const DEADLINE_SCOUT_DISPATCH_CONCURRENCY = 4;

// Recovery graphs expose only lease retirement; workers own every other edge.
const DEADLINE_DISPATCH_RECOVERY = defineScopedTransitions({
  table: documentProcessingRuns,
  key: "id",
  scope: [],
  stateColumn: "deadlineScoutStatus",
  edges: {
    not_requested: [],
    pending: [],
    running: ["pending"],
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

/** The two dependencies this sweep needs, so the scheduler can run it without
 *  assembling the whole reconciliation set and a test can drive it with a
 *  stubbed queue. */
type RecoverDocumentDeadlineScoutDispatchesOptions = {
  database: typeof rootDb;
  enqueueDocumentDeadlineScout?: typeof enqueueDocumentDeadlineScout;
};

/**
 * Return expired scout dispatches to `pending` and hand every pending one to
 * the scout queue.
 *
 * Exported because the scout worker and this dispatcher live in different
 * processes: the worker starts with the API server, while the reconciliation
 * loop that used to be the dispatcher's only driver runs in the document
 * processing worker. Wherever that worker is absent, `pending` rows had
 * nothing to dispatch them. The scheduler runs it too; the enqueue is keyed by
 * the source run, so the two drivers converge rather than duplicating work.
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
  const staleDispatches = await database
    .select({ id: documentProcessingRuns.id })
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
    )
    .limit(RECONCILE_BATCH_SIZE);
  // Compare-and-set on the state the select matched, not on the id alone.
  // This sweep runs in the scheduler and in the processing worker's own
  // reconciliation loop, so two of them can select the same expired dispatch.
  // Once the first resets it a worker claims a fresh attempt, and an id-only
  // update from the second would push that live claim back to `pending`: the
  // worker's settlement predicate then rejects its own result and the metered
  // scan is replayed on every later sweep. Re-asserting `running` and the same
  // expired claim makes the second update match nothing.
  const reclaimedDispatchCount =
    staleDispatches.length === 0
      ? 0
      : await transitionScopedCount({
          tx: database,
          spec: DEADLINE_DISPATCH_RECOVERY,
          where: sql`${and(
            inArray(
              documentProcessingRuns.id,
              staleDispatches.map(({ id }) => id),
            ),
            eq(documentProcessingRuns.deadlineScoutStatus, "running"),
            lt(documentProcessingRuns.deadlineScoutClaimedAt, staleBefore),
          )}`,
          options: {
            from: ["running"],
            to: "pending",
            set: {
              deadlineScoutClaimedAt: null,
              deadlineScoutErrorCode: "worker_lease_expired",
              updatedAt: new Date(),
            },
          },
          recordTransitionAuditEvent: (_tx, count) => {
            logger.info("scout.document_deadlines.dispatches_reclaimed", {
              count,
            });
          },
        });

  const staleCensusRuns = await database
    .select({ id: scoutRuns.id })
    .from(scoutRuns)
    .where(
      and(
        eq(scoutRuns.scoutKey, SCOUT_KEY.DOCUMENT_DEADLINES),
        eq(scoutRuns.status, SCOUT_RUN_STATUS.RUNNING),
        lt(scoutRuns.startedAt, staleBefore),
      ),
    )
    .orderBy(asc(scoutRuns.startedAt), asc(scoutRuns.id))
    .limit(RECONCILE_BATCH_SIZE);
  // Same compare-and-set, so a census run that restarted between the select
  // and this update is not retired out from under its worker.
  const failedCensusCount =
    staleCensusRuns.length === 0
      ? 0
      : await transitionScopedCount({
          tx: database,
          spec: DEADLINE_CENSUS_RECOVERY,
          where: sql`${and(
            inArray(
              scoutRuns.id,
              staleCensusRuns.map(({ id }) => id),
            ),
            eq(scoutRuns.status, SCOUT_RUN_STATUS.RUNNING),
            lt(scoutRuns.startedAt, staleBefore),
          )}`,
          options: {
            from: ["running"],
            to: "failed",
            set: {
              error: "worker_lease_expired",
              finishedAt: new Date(),
            },
          },
          recordTransitionAuditEvent: (_tx, count) => {
            logger.info("scout.document_deadlines.census_runs_expired", {
              count,
            });
          },
        });

  const pending = await database
    .select({ sourceRunId: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.deadlineScoutStatus, "pending"),
        deadlineScoutDue(new Date()),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.updatedAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);

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
      reclaimedDispatchCount +
      failedCensusCount +
      results.filter(Result.isOk).length,
    hasMore:
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
