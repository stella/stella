import type { RegisteredSchedulerTaskName } from "@/api/lib/scheduler/registry";

/**
 * How each scheduler task bounds what it reads from the corpus-sized tables
 * (`PLAN_GUARD_TABLES`).
 *
 * A scheduled read runs unattended on every interval, on the same database
 * the request path reads, so a statement that walks one of those tables whole
 * costs every reader for as long as it runs, every time it runs, and nothing
 * on the request path shows why. The query-plan registry
 * (`apps/api/src/tests/query-plans/registry.ts`) pins each registered
 * statement's access path on scale-shaped statistics and refuses a sequential
 * scan of a guarded table; this census says which of those statements are a
 * task's reads, so a task cannot read a guarded table without one.
 *
 * - `plan-registered`: every read the task makes of a guarded table is one of
 *   these registry entries. An entry whose contract still allows a sequential
 *   scan is named again in `acceptedSequentialScans`, so the exemption is
 *   visible where the task is, not only in the plan contract.
 * - `no-guarded-reads`: the task reads no guarded table.
 * - `unreviewed`: not yet classified. `task-read-budget.test.ts` holds these
 *   to a shrink-only baseline, so a task added after the census must declare
 *   one of the other two.
 */
export type SchedulerTaskReadBudget =
  | {
      type: "plan-registered";
      queryPlanIds: readonly [string, ...string[]];
      acceptedSequentialScans: readonly string[];
    }
  | { type: "no-guarded-reads"; reason: string }
  | { type: "unreviewed" };

const UNREVIEWED = { type: "unreviewed" } as const;

const planRegistered = (
  ...queryPlanIds: readonly [string, ...string[]]
): SchedulerTaskReadBudget => ({
  type: "plan-registered",
  queryPlanIds,
  acceptedSequentialScans: [],
});

/** Every registered scheduler task, classified; a missing task does not compile. */
export const SCHEDULER_TASK_READ_BUDGET = {
  "actions.sweepCosts": UNREVIEWED,
  "agentClients.backfillStorage": UNREVIEWED,
  "audit.purgeSystemRuns": planRegistered("system-audit.purge-candidates"),
  "auth.sweepRegistrations": UNREVIEWED,
  "backfill.emitHeartbeat": UNREVIEWED,
  "bilingualTranslations.reconcileQueuedRuns": UNREVIEWED,
  "caseLaw.backfillProvisionState": UNREVIEWED,
  "caseLaw.backfillRedactionTombstones": UNREVIEWED,
  "caseLaw.censusRawObjects": UNREVIEWED,
  // The convergence status's census probes (`corpus-index-projection-
  // convergence.ts`) run only once the queue is quiet and are not registered
  // yet; the queue probe that runs every time is.
  "caseLaw.reportFreshness": planRegistered(
    "case-law.freshness-pending-states",
    "corpus-index.convergence-state-probe",
  ),
  "caseLaw.reconcileCorpusUploadIntents": UNREVIEWED,
  "caseLaw.reconcileRawRows": UNREVIEWED,
  "caseLaw.reconcileRawSweeps": UNREVIEWED,
  "caseLaw.refreshBrowseFacets": UNREVIEWED,
  "caseLaw.refreshSitemapShards": planRegistered("case-law.sitemap-refresh"),
  "caseLaw.refreshSourceArrivals": planRegistered(
    "case-law.source-arrivals-refresh",
  ),
  "chat.compactThreads": UNREVIEWED,
  "chat.reapOwnerlessTurns": UNREVIEWED,
  "chat.purgeSecrets": UNREVIEWED,
  "chat.sweepRunLogs": UNREVIEWED,
  "corpusIndex.backfillJobDetail": UNREVIEWED,
  "desktopEditSessions.expire": UNREVIEWED,
  "documentProcessing.dispatchOcr": UNREVIEWED,
  "documentProcessing.dispatchNativeExtraction": UNREVIEWED,
  "documentProcessing.recoverDeadlineScouts": UNREVIEWED,
  "documentReviews.reconcileQueuedRuns": UNREVIEWED,
  "entityBuffers.reconcileIntents": UNREVIEWED,
  "fileComparisons.sweepExpired": UNREVIEWED,
  "files.reconcileReservations": UNREVIEWED,
  "files.repairDerivatives": UNREVIEWED,
  "flow.run": UNREVIEWED,
  "flows.reconcileOrphanRuns": UNREVIEWED,
  "inboundMail.receive": UNREVIEWED,
  "infosoud.syncTrackedCases": UNREVIEWED,
  "legislation.backfillExpressionIds": UNREVIEWED,
  "legislation.refreshFacetCounts": {
    type: "plan-registered",
    queryPlanIds: ["legislation.facets-refresh"],
    // Its contract still allows the hourly full-corpus snapshot scan.
    acceptedSequentialScans: ["legislation.facets-refresh"],
  },
  "legislation.refreshSitemapShards": UNREVIEWED,
  "listVerifications.reconcileQueuedRuns": UNREVIEWED,
  "memory.curator": UNREVIEWED,
  "memory.extractor": UNREVIEWED,
  "observability.checkDataInvariants": UNREVIEWED,
  "organizations.recordMissingAccessStates": UNREVIEWED,
  "reviewOrganization.reset": UNREVIEWED,
  "reportExports.reconcileQueued": UNREVIEWED,
  "sanctions.backfillMonitoring": UNREVIEWED,
  "sanctions.drainMonitoring": UNREVIEWED,
  "sanctions.refreshSources": UNREVIEWED,
  "scheduler.auditPauses": UNREVIEWED,
  "scheduler.dispatchBullMq": UNREVIEWED,
  "scheduler.noop": {
    type: "no-guarded-reads",
    reason: "Does nothing; it exists to exercise the runner.",
  },
  "search.repairChatIndex": UNREVIEWED,
  "search.repairProjections": UNREVIEWED,
  "search.repairSemanticTimestamps": UNREVIEWED,
  "styleSets.reconcilePackageCleanups": UNREVIEWED,
  "templates.cleanDeletionObjects": UNREVIEWED,
  "usage.redactWebhookEvents": UNREVIEWED,
  "workObligations.attentionScout": UNREVIEWED,
  "workObligations.backfillLegacyTasks": UNREVIEWED,
} as const satisfies Record<
  RegisteredSchedulerTaskName,
  SchedulerTaskReadBudget
>;
