import type { QueueAuthority } from "@/api/lib/member-run-queues";
import type { RegisteredSchedulerTaskName } from "@/api/lib/scheduler/registry";

/**
 * Calls that settle, each time a member run executes, that its member may
 * still act where the run reads and writes.
 */
export const MEMBER_RUN_ACTOR_RESOLVERS = [
  "createRootRunActor",
  "resolveMemberAuthorization",
  // Holds the member's rows for the whole transaction that reads and writes.
  "holdMemberAccessOnTx",
] as const;

type MemberRunActorResolver = (typeof MEMBER_RUN_ACTOR_RESOLVERS)[number];

type TaskAuthorityBase = {
  /** The module that implements the task the registry runs. */
  module: string;
  /** Why the task runs under this authority. */
  reason: string;
};

/**
 * Whose authority a scheduler task runs under, in the terms of
 * `QUEUE_AUTHORITY` (apps/api/src/lib/member-run-queues.ts).
 *
 * `unclassified` is for a task whose code does not settle who it acts for;
 * `scripts/queue-authority.ts` holds those to its shrink-only baseline.
 */
export type SchedulerTaskAuthorityEntry =
  | (TaskAuthorityBase & {
      authority: Exclude<QueueAuthority, "member-run">;
    })
  | (TaskAuthorityBase & {
      authority: "member-run";
      /** Where the task settles its member's access each time it runs, or
       *  `null` when it does not (held to the baseline). */
      runActor: { module: string; resolver: MemberRunActorResolver } | null;
    })
  | (TaskAuthorityBase & { authority: "unclassified" });

/** Every registered scheduler task, classified. A task added to the
 *  scheduler registry without a row here does not compile. */
export type SchedulerTaskAuthorityRegistry = Record<
  RegisteredSchedulerTaskName,
  SchedulerTaskAuthorityEntry
>;

const TASKS = "apps/api/src/lib/scheduler/tasks";

const platform = (module: string, reason: string) =>
  ({
    authority: "org-automation",
    module: `${TASKS}/${module}`,
    reason,
  }) as const satisfies SchedulerTaskAuthorityEntry;

export const SCHEDULER_TASK_AUTHORITY = {
  "actions.sweepCosts": platform(
    "action-cost-retention.ts",
    "Retention sweep of usage records past their window.",
  ),
  "agentClients.backfillStorage": platform(
    "agent-client-storage-backfill.ts",
    "Storage migration of client credentials.",
  ),
  "audit.purgeSystemRuns": platform(
    "system-audit-retention.ts",
    "Retention sweep of system audit runs.",
  ),
  "auth.sweepRegistrations": platform(
    "registration-retention.ts",
    "Retention sweep of registration records.",
  ),
  "backfill.emitHeartbeat": platform(
    "backfill-heartbeat.ts",
    "Reports backfill state from scheduler rows.",
  ),
  "bilingualTranslations.reconcileQueuedRuns": platform(
    "bilingual-run-reconcile.ts",
    "Hands queued runs back to their queue, whose worker resolves the requester's run actor.",
  ),
  "caseLaw.backfillProvisionState": platform(
    "case-law-provision-state-backfill.ts",
    "Public legal corpus maintenance.",
  ),
  "caseLaw.backfillRedactionTombstones": platform(
    "case-law-redaction-tombstone-backfill.ts",
    "Public legal corpus maintenance.",
  ),
  "caseLaw.censusRawObjects": platform(
    "case-law-raw-storage.ts",
    "Public legal corpus storage census.",
  ),
  "caseLaw.reconcileCorpusUploadIntents": platform(
    "case-law-corpus-upload-cleanup.ts",
    "Public legal corpus upload cleanup.",
  ),
  "caseLaw.reconcileRawRows": platform(
    "case-law-raw-storage.ts",
    "Public legal corpus storage reconciliation.",
  ),
  "caseLaw.reconcileRawSweeps": platform(
    "case-law-raw-storage.ts",
    "Public legal corpus storage reconciliation.",
  ),
  "caseLaw.refreshBrowseFacets": platform(
    "case-law-browse-facet-refresh.ts",
    "Public legal corpus aggregates.",
  ),
  "caseLaw.refreshSitemapShards": platform(
    "case-law-sitemap-shard-refresh.ts",
    "Public legal corpus sitemap.",
  ),
  "chat.compactThreads": {
    authority: "member-run",
    module: `${TASKS}/chat-thread-compactor.ts`,
    runActor: {
      module: `${TASKS}/chat-thread-compactor.ts`,
      resolver: "holdMemberAccessOnTx",
    },
    reason:
      "Summarizes a thread for its owner, holding the owner's current membership for every read and write.",
  },
  "chat.reapOwnerlessTurns": platform(
    "chat-turn-reaper.ts",
    "Ends chat turns whose lease expired; reads no content.",
  ),
  "chat.sweepRunLogs": platform(
    "chat-run-log-retention.ts",
    "Retention sweep of closed run logs.",
  ),
  "corpusIndex.backfillJobDetail": platform(
    "corpus-index-job-detail-backfill.ts",
    "Public legal corpus index bookkeeping.",
  ),
  "desktopEditSessions.expire": platform(
    "desktop-edit-session-expiry.ts",
    "Expires sessions past their token lifetime, recorded as a service.",
  ),
  "documentProcessing.dispatchOcr": platform(
    "document-processing-ocr.ts",
    "Hands queued document processing runs to their queue.",
  ),
  "documentProcessing.recoverDeadlineScouts": platform(
    "document-deadline-scout-recovery.ts",
    "Hands pending deadline scans to their queue.",
  ),
  "documentReviews.reconcileQueuedRuns": platform(
    "document-review-run-reconcile.ts",
    "Hands queued runs back to their queue, whose worker resolves the requester's run actor.",
  ),
  "entityBuffers.reconcileIntents": platform(
    "buffer-intent-reconciliation.ts",
    "Removes stored objects of abandoned writes.",
  ),
  "fileComparisons.sweepExpired": platform(
    "file-comparison-sweep.ts",
    "Removes expired comparison uploads.",
  ),
  "files.reconcileReservations": platform(
    "organization-file-reservation-reconcile.ts",
    "Settles abandoned storage reservations of an organization.",
  ),
  "files.repairDerivatives": platform(
    "file-derivative-repair.ts",
    "Hands stuck renditions back to the derivatives queue.",
  ),
  "flow.run": {
    authority: "member-run",
    module: `${TASKS}/flow-run.ts`,
    runActor: {
      module: "apps/api/src/lib/flows/start-automated-flow-run.ts",
      resolver: "resolveMemberAuthorization",
    },
    reason:
      "Starts a scheduled flow as its author, after checking the author's access to the workspace.",
  },
  "flows.reconcileOrphanRuns": platform(
    "flow-run-orphan-reconcile.ts",
    "Hands stalled flow runs back to their queue.",
  ),
  "inboundMail.receive": platform(
    "inbound-mail-receive.ts",
    "Drains the platform's inbound mail queue across organizations; each delivery is filed only after its recipient token resolves the matter and the sender's current access is rechecked.",
  ),
  "infosoud.syncTrackedCases": platform(
    "infosoud.ts",
    "Imports public court events into the workspace that tracks the case; reads no member content.",
  ),
  "legislation.backfillExpressionIds": platform(
    "legislation-expression-id-backfill.ts",
    "Public legal corpus maintenance.",
  ),
  "legislation.refreshSitemapShards": platform(
    "statute-sitemap-shard-refresh.ts",
    "Public legal corpus sitemap.",
  ),
  "listVerifications.reconcileQueuedRuns": platform(
    "list-verification-run-reconcile.ts",
    "Fails stuck runs and hands queued runs back to their queue, whose worker resolves the requester's run actor.",
  ),
  "memory.curator": platform(
    "memory-curator.ts",
    "Ages memories by their timestamps, recorded as a service.",
  ),
  "memory.extractor": {
    authority: "member-run",
    module: `${TASKS}/memory-extractor.ts`,
    runActor: {
      module: `${TASKS}/memory-extractor.ts`,
      resolver: "createRootRunActor",
    },
    reason:
      "Reads a thread owner's compacted chat and stores memory suggestions attributed to that owner, as that owner's run actor.",
  },
  "organizations.recordMissingAccessStates": platform(
    "organization-access-state-reconcile.ts",
    "Records organization access state.",
  ),
  "reviewOrganization.reset": platform(
    "review-organization-reset.ts",
    "Resets the configured restricted review organization; each run first proves its only member is the configured review account.",
  ),
  "reportExports.reconcileQueued": platform(
    "report-export-reconcile.ts",
    "Recovers stuck exports and hands queued ones back to their queue, whose worker resolves the requester's run actor.",
  ),
  "sanctions.backfillMonitoring": platform(
    "sanctions-monitoring-backfill.ts",
    "Refreshes organization-scoped contact coverage after sanctions source changes.",
  ),
  "sanctions.drainMonitoring": platform(
    "sanctions-monitoring.ts",
    "Processes organization-scoped contact screening marks without a member run.",
  ),
  "sanctions.refreshSources": platform(
    "sanctions-refresh.ts",
    "Refreshes public sanctions lists.",
  ),
  "scheduler.dispatchBullMq": {
    authority: "unclassified",
    module: "apps/api/src/lib/scheduler/bullmq.ts",
    reason:
      "Forwards to whichever queue a stored job names; the code does not fix the target queue, so the authority depends on data.",
  },
  "scheduler.noop": {
    authority: "org-automation",
    module: "apps/api/src/lib/scheduler/registry.ts",
    reason: "Does nothing.",
  },
  "search.repairChatIndex": platform(
    "search-chat-index.ts",
    "Search index maintenance.",
  ),
  "search.repairProjections": platform(
    "search-projection-repair.ts",
    "Search index maintenance.",
  ),
  "search.repairSemanticTimestamps": platform(
    "search-semantic-timestamps.ts",
    "Search index maintenance.",
  ),
  "styleSets.reconcilePackageCleanups": platform(
    "style-set-package-cleanup-reconcile.ts",
    "Hands pending package cleanups to their queue.",
  ),
  "templates.cleanDeletionObjects": platform(
    "template-deletion-cleanup.ts",
    "Removes stored objects of deleted templates.",
  ),
  "usage.redactWebhookEvents": platform(
    "hosted-usage-webhook-retention.ts",
    "Retention redaction of provider events.",
  ),
  "workObligations.attentionScout": platform(
    "work-attention-scout.ts",
    "Emits unassigned organization signals; its session identity decides no visibility.",
  ),
  "workObligations.backfillLegacyTasks": platform(
    "work-obligation-backfill.ts",
    "Data backfill from existing tasks, keeping only current members as assignees.",
  ),
} as const satisfies SchedulerTaskAuthorityRegistry;
