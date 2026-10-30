import type { DECLARED_SCHEDULER_JOBS } from "./jobs";

type DeclaredTask = (typeof DECLARED_SCHEDULER_JOBS)[number]["task"];

type DeclarationHarnessDisposition =
  { status: "run" } | { status: "excluded"; reason: string };

// Exclusions are checked against the merge base by declaration-harness.test.ts.
export const SCHEDULER_DECLARATION_HARNESS = {
  "requests.sweepReceipts": { status: "run" },
  "caseLaw.refreshCoverage": {
    status: "excluded",
    reason:
      "The governed runtime owns dedicated health/repair sessions; requires a fixture-owned runtime factory before relation counters can cover every backend.",
  },
  "scheduler.auditPauses": { status: "run" },
  "documentProcessing.dispatchOcr": { status: "run" },
  "documentProcessing.dispatchNativeExtraction": { status: "run" },
  "documentProcessing.recoverDeadlineScouts": { status: "run" },
  "entityBuffers.reconcileIntents": { status: "run" },
  "files.reconcileReservations": {
    status: "excluded",
    reason:
      "The deployment file-usage feature gate can return before the database branch; requires a feature-enabled fixture.",
  },
  "inboundMail.receive": {
    status: "excluded",
    reason:
      "The registry adapter requires configured mail credentials and a receiving service fixture.",
  },
  "emailDeliverability.receive": {
    status: "excluded",
    reason:
      "The registry adapter requires an authenticated provider-event queue fixture.",
  },
  "fileComparisons.sweepExpired": { status: "run" },
  "caseLaw.reconcileCorpusUploadIntents": { status: "run" },
  "caseLaw.refreshSitemapShards": { status: "run" },
  "caseLaw.reportFreshness": { status: "run" },
  "organizations.recordMissingAccessStates": {
    status: "excluded",
    reason:
      "The deployment access-state feature gate determines whether a database branch runs; requires both enforcement fixtures.",
  },
  "reviewOrganization.reset": {
    status: "excluded",
    reason:
      "The configured review-organization reset rebuilds a tenant graph and needs a dedicated review-tenant seed.",
  },
  "caseLaw.refreshBrowseFacets": {
    status: "excluded",
    reason:
      "The long-running connection owner opens a dedicated backend outside the single-backend counter fixture.",
  },
  "legislation.refreshSitemapShards": { status: "run" },
  "legislation.refreshFacetCounts": {
    status: "excluded",
    reason:
      "The long-running connection owner opens a dedicated backend outside the single-backend counter fixture.",
  },
  "caseLaw.refreshSourceArrivals": {
    status: "excluded",
    reason:
      "The long-running connection owner opens a dedicated backend outside the single-backend counter fixture.",
  },
  "caseLaw.reconcileRawSweeps": {
    status: "excluded",
    reason:
      "The ingestion-role connection and raw-object bucket need an isolated storage fixture.",
  },
  "caseLaw.reconcileRawRows": {
    status: "excluded",
    reason:
      "The ingestion-role connection and raw-object bucket need an isolated storage fixture.",
  },
  "caseLaw.reconcileDecisionIdentifiers": {
    status: "excluded",
    reason:
      "The load governor and corpus-role connection need injected admission and a fixture-owned corpus backend.",
  },
  "caseLaw.censusRawObjects": {
    status: "excluded",
    reason:
      "The ingestion-role connection and raw-object bucket need an isolated storage fixture.",
  },
  "caseLaw.backfillRedactionTombstones": { status: "run" },
  "agentClients.backfillStorage": {
    status: "excluded",
    reason:
      "The deployment storage-cutover flag admits this task; requires an enabled admission fixture.",
  },
  "caseLaw.backfillProvisionState": {
    status: "excluded",
    reason:
      "The repair owns dedicated sessions and online-DDL admission; requires a fixture-owned repair runtime.",
  },
  "legislation.backfillExpressionIds": {
    status: "excluded",
    reason:
      "The governed repair runtime opens independent health sessions; requires injected fixture admission.",
  },
  "backfill.emitHeartbeat": { status: "run" },
  "observability.checkDataInvariants": {
    status: "excluded",
    reason:
      "The catalog spans public-law and ingestion pools plus configured canaries; requires all read-role fixture backends.",
  },
  "corpusIndex.backfillJobDetail": {
    status: "excluded",
    reason:
      "The terminal validation opens a dedicated DDL session outside this backend counter fixture.",
  },
  "workObligations.backfillLegacyTasks": {
    status: "excluded",
    reason:
      "The governed-workflow deployment flag can return before database work; requires an enabled workflow fixture.",
  },
  "workObligations.attentionScout": {
    status: "excluded",
    reason:
      "The governed-workflow deployment flag can return before database work; requires an enabled workflow fixture.",
  },
  "search.repairChatIndex": {
    status: "excluded",
    reason:
      "This task reads through an ambient root connection instead of its injected scheduler database.",
  },
  "search.repairProjections": { status: "run" },
  "flows.reconcileOrphanRuns": { status: "run" },
  "files.repairDerivatives": { status: "run" },
  "chat.reapOwnerlessTurns": { status: "run" },
  "auth.sweepRegistrations": { status: "run" },
  "audit.purgeSystemRuns": { status: "run" },
  "usage.redactWebhookEvents": {
    status: "excluded",
    reason:
      "A configured retention window admits this task; requires an explicit retention configuration fixture.",
  },
  "actions.sweepCosts": {
    status: "excluded",
    reason:
      "Deployment feature and retention settings admit this task; requires enabled action-cost configuration.",
  },
  "chat.sweepRunLogs": { status: "run" },
  "chat.purgeSecrets": { status: "run" },
  "documentReviews.reconcileQueuedRuns": {
    status: "excluded",
    reason:
      "The registered reconciler eagerly obtains its BullMQ adapter; requires a fake queue at its factory boundary.",
  },
  "listVerifications.reconcileQueuedRuns": {
    status: "excluded",
    reason:
      "The registered reconciler eagerly obtains its BullMQ adapter; requires a fake queue at its factory boundary.",
  },
  "bilingualTranslations.reconcileQueuedRuns": {
    status: "excluded",
    reason:
      "The registered reconciler eagerly obtains its BullMQ adapter; requires a fake queue at its factory boundary.",
  },
  "reportExports.reconcileQueued": {
    status: "excluded",
    reason:
      "The registered reconciler eagerly obtains its BullMQ adapter; requires a fake queue at its factory boundary.",
  },
  "styleSets.reconcilePackageCleanups": {
    status: "excluded",
    reason:
      "The registered reconciler eagerly obtains its BullMQ adapter; requires a fake queue at its factory boundary.",
  },
  "templates.cleanDeletionObjects": { status: "run" },
  "search.repairSemanticTimestamps": { status: "run" },
  "infosoud.syncTrackedCases": { status: "run" },
  "sanctions.backfillMonitoring": {
    status: "excluded",
    reason:
      "Tenant-specific passes open scoped backends after fanout; requires fixture-owned scoped connections.",
  },
  "sanctions.drainMonitoring": { status: "run" },
  "sanctions.refreshSources": {
    status: "excluded",
    reason:
      "The source refresh owns ingestion sessions and authenticated outbound adapters; requires isolated source fixtures.",
  },
  "desktopEditSessions.expire": { status: "run" },
  "memory.curator": {
    status: "excluded",
    reason:
      "The deployed AI-memory feature admits this task; requires a feature-enabled tenant fixture.",
  },
  "memory.extractor": {
    status: "excluded",
    reason:
      "The deployed AI-memory feature and metered model adapter require a consented tenant/model fixture.",
  },
  "chat.compactThreads": {
    status: "excluded",
    reason:
      "Compaction uses ambient scoped backends and a metered model adapter; requires a consented tenant/model fixture.",
  },
} as const satisfies Record<DeclaredTask, DeclarationHarnessDisposition>;
