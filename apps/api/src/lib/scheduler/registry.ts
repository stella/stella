import { createBullMqDispatchTask } from "@/api/lib/scheduler/bullmq";
import {
  SWEEP_ACTION_COSTS_TASK,
  sweepActionCostRecords,
} from "@/api/lib/scheduler/tasks/action-cost-retention";
import {
  BACKFILL_AGENT_CLIENT_STORAGE_TASK,
  backfillAgentClientStorage,
} from "@/api/lib/scheduler/tasks/agent-client-storage-backfill";
import {
  BACKFILL_HEARTBEAT_TASK,
  emitBackfillHeartbeats,
} from "@/api/lib/scheduler/tasks/backfill-heartbeat";
import {
  RECONCILE_BILINGUAL_RUNS_TASK,
  reconcileBilingualRuns,
} from "@/api/lib/scheduler/tasks/bilingual-run-reconcile";
import {
  RECONCILE_BUFFER_INTENTS_TASK,
  reconcileBufferIntents,
} from "@/api/lib/scheduler/tasks/buffer-intent-reconciliation";
import {
  REFRESH_CASE_LAW_BROWSE_FACETS_TASK,
  refreshCaseLawBrowseFacetsTask,
} from "@/api/lib/scheduler/tasks/case-law-browse-facet-refresh";
import {
  RECONCILE_CASE_LAW_CORPUS_UPLOAD_INTENTS_TASK,
  reconcileCaseLawCorpusUploadIntentsTask,
} from "@/api/lib/scheduler/tasks/case-law-corpus-upload-cleanup";
import {
  BACKFILL_CASE_LAW_PROVISION_STATE_TASK,
  backfillCaseLawProvisionState,
} from "@/api/lib/scheduler/tasks/case-law-provision-state-backfill";
import {
  CENSUS_CASE_LAW_RAW_OBJECTS_TASK,
  censusCaseLawRawObjectsTask,
  RECONCILE_CASE_LAW_RAW_ROWS_TASK,
  RECONCILE_CASE_LAW_RAW_SWEEPS_TASK,
  reconcileCaseLawRawRowsTask,
  reconcileCaseLawRawSweepsTask,
} from "@/api/lib/scheduler/tasks/case-law-raw-storage";
import {
  BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  backfillCaseLawRedactionTombstones,
} from "@/api/lib/scheduler/tasks/case-law-redaction-tombstone-backfill";
import {
  REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK,
  refreshCaseLawSitemapShardsTask,
} from "@/api/lib/scheduler/tasks/case-law-sitemap-shard-refresh";
import {
  REFRESH_CASE_LAW_SOURCE_ARRIVALS_TASK,
  refreshCaseLawSourceArrivalsTask,
} from "@/api/lib/scheduler/tasks/case-law-source-arrivals-refresh";
import {
  SWEEP_CHAT_RUN_LOGS_TASK,
  sweepChatRunLogs,
} from "@/api/lib/scheduler/tasks/chat-run-log-retention";
import {
  CHAT_THREAD_COMPACTOR_TASK,
  compactChatThreads,
} from "@/api/lib/scheduler/tasks/chat-thread-compactor";
import { REAP_OWNERLESS_CHAT_TURNS_TASK } from "@/api/lib/scheduler/tasks/chat-turn-reaper";
import {
  BACKFILL_CORPUS_INDEX_JOB_DETAIL_TASK,
  backfillCorpusIndexJobDetail,
} from "@/api/lib/scheduler/tasks/corpus-index-job-detail-backfill";
import {
  EXPIRE_DESKTOP_EDIT_SESSIONS_TASK,
  expireDesktopEditSessions,
} from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry";
import {
  RECOVER_DOCUMENT_DEADLINE_SCOUTS_TASK,
  recoverDocumentDeadlineScouts,
} from "@/api/lib/scheduler/tasks/document-deadline-scout-recovery";
import {
  DISPATCH_DOCUMENT_OCR_TASK,
  dispatchDocumentOcr,
} from "@/api/lib/scheduler/tasks/document-processing-ocr";
import {
  RECONCILE_DOCUMENT_REVIEW_RUNS_TASK,
  reconcileDocumentReviewRuns,
} from "@/api/lib/scheduler/tasks/document-review-run-reconcile";
import {
  SWEEP_FILE_COMPARISON_UPLOADS_TASK,
  sweepFileComparisonUploads,
} from "@/api/lib/scheduler/tasks/file-comparison-sweep";
import {
  REPAIR_FILE_DERIVATIVES_TASK,
  repairFileDerivatives,
} from "@/api/lib/scheduler/tasks/file-derivative-repair";
import {
  FLOW_RUN_TASK,
  runScheduledFlow,
} from "@/api/lib/scheduler/tasks/flow-run";
import {
  RECONCILE_FLOW_RUN_ORPHANS_TASK,
  reconcileFlowRunOrphans,
} from "@/api/lib/scheduler/tasks/flow-run-orphan-reconcile";
import {
  REDACT_HOSTED_USAGE_WEBHOOK_EVENTS_TASK,
  redactHostedUsageWebhookEvents,
} from "@/api/lib/scheduler/tasks/hosted-usage-webhook-retention";
import {
  RECEIVE_INBOUND_MAIL_TASK,
  receiveInboundMail,
} from "@/api/lib/scheduler/tasks/inbound-mail-receive";
import {
  INFO_SOUD_SYNC_TRACKED_CASES_TASK,
  syncInfoSoudTrackedCases,
} from "@/api/lib/scheduler/tasks/infosoud";
import {
  BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK,
  backfillLegislationExpressionIds,
} from "@/api/lib/scheduler/tasks/legislation-expression-id-backfill";
import {
  REFRESH_LEGISLATION_FACETS_TASK,
  refreshLegislationFacetsTask,
} from "@/api/lib/scheduler/tasks/legislation-facet-refresh";
import {
  RECONCILE_LIST_VERIFICATION_RUNS_TASK,
  reconcileListVerificationRuns,
} from "@/api/lib/scheduler/tasks/list-verification-run-reconcile";
import {
  MEMORY_CURATOR_TASK,
  curateAiMemories,
} from "@/api/lib/scheduler/tasks/memory-curator";
import {
  MEMORY_EXTRACTOR_TASK,
  extractMemoriesFromCompactions,
} from "@/api/lib/scheduler/tasks/memory-extractor";
import {
  RECORD_MISSING_ORGANIZATION_ACCESS_STATES_TASK,
  recordMissingOrganizationAccessStatesTask,
} from "@/api/lib/scheduler/tasks/organization-access-state-reconcile";
import {
  RECONCILE_ORGANIZATION_FILE_RESERVATIONS_TASK,
  reconcileOrganizationFileReservations,
} from "@/api/lib/scheduler/tasks/organization-file-reservation-reconcile";
import {
  SWEEP_REGISTRATIONS_TASK,
  sweepRegistrationRecords,
} from "@/api/lib/scheduler/tasks/registration-retention";
import {
  RECONCILE_REPORT_EXPORTS_TASK,
  reconcileReportExports,
} from "@/api/lib/scheduler/tasks/report-export-reconcile";
import {
  RESET_REVIEW_ORGANIZATION_TASK,
  resetReviewOrganizationTask,
} from "@/api/lib/scheduler/tasks/review-organization-reset";
import {
  DRAIN_SANCTIONS_MONITORING_TASK,
  drainSanctionsMonitoringTask,
} from "@/api/lib/scheduler/tasks/sanctions-monitoring";
import {
  BACKFILL_SANCTIONS_MONITORING_TASK,
  backfillSanctionsMonitoringTask,
} from "@/api/lib/scheduler/tasks/sanctions-monitoring-backfill";
import {
  REFRESH_SANCTIONS_SOURCES_TASK,
  refreshSanctionsSourcesTask,
} from "@/api/lib/scheduler/tasks/sanctions-refresh";
import {
  REPAIR_CHAT_SEARCH_INDEX_TASK,
  repairChatSearchIndex,
} from "@/api/lib/scheduler/tasks/search-chat-index";
import {
  REPAIR_SEARCH_PROJECTIONS_TASK,
  repairSearchProjections,
} from "@/api/lib/scheduler/tasks/search-projection-repair";
import {
  REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK,
  repairSearchSemanticTimestampsTask,
} from "@/api/lib/scheduler/tasks/search-semantic-timestamps";
import {
  REFRESH_STATUTE_SITEMAP_SHARDS_TASK,
  refreshStatuteSitemapShardsTask,
} from "@/api/lib/scheduler/tasks/statute-sitemap-shard-refresh";
import {
  RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK,
  reconcileStyleSetPackageCleanups,
} from "@/api/lib/scheduler/tasks/style-set-package-cleanup-reconcile";
import {
  PURGE_SYSTEM_AUDIT_RUNS_TASK,
  purgeSystemAuditRunsTask,
} from "@/api/lib/scheduler/tasks/system-audit-retention";
import {
  CLEAN_TEMPLATE_DELETION_OBJECTS_TASK,
  cleanTemplateDeletionObjects,
} from "@/api/lib/scheduler/tasks/template-deletion-cleanup";
import {
  WORK_ATTENTION_SCOUT_TASK,
  runWorkAttentionScoutTask,
} from "@/api/lib/scheduler/tasks/work-attention-scout";
import {
  BACKFILL_WORK_OBLIGATIONS_TASK,
  backfillWorkObligations,
} from "@/api/lib/scheduler/tasks/work-obligation-backfill";
import type {
  SchedulerTask,
  SchedulerTaskRegistry,
} from "@/api/lib/scheduler/types";

const noopTask: SchedulerTask = ({ logger }) => {
  logger.debug("scheduler.noop");
};

const SCHEDULER_TASKS = {
  [REDACT_HOSTED_USAGE_WEBHOOK_EVENTS_TASK]: redactHostedUsageWebhookEvents,
  [BACKFILL_AGENT_CLIENT_STORAGE_TASK]: backfillAgentClientStorage,
  [BACKFILL_HEARTBEAT_TASK]: emitBackfillHeartbeats,
  "scheduler.noop": noopTask,
  "scheduler.dispatchBullMq": createBullMqDispatchTask(),
  [INFO_SOUD_SYNC_TRACKED_CASES_TASK]: syncInfoSoudTrackedCases,
  [BACKFILL_SANCTIONS_MONITORING_TASK]: backfillSanctionsMonitoringTask,
  [DRAIN_SANCTIONS_MONITORING_TASK]: drainSanctionsMonitoringTask,
  [RECEIVE_INBOUND_MAIL_TASK]: receiveInboundMail,
  [REFRESH_SANCTIONS_SOURCES_TASK]: refreshSanctionsSourcesTask,
  [EXPIRE_DESKTOP_EDIT_SESSIONS_TASK]: expireDesktopEditSessions,
  [DISPATCH_DOCUMENT_OCR_TASK]: dispatchDocumentOcr,
  [FLOW_RUN_TASK]: runScheduledFlow,
  [BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK]:
    backfillCaseLawRedactionTombstones,
  [BACKFILL_CASE_LAW_PROVISION_STATE_TASK]: backfillCaseLawProvisionState,
  [BACKFILL_CORPUS_INDEX_JOB_DETAIL_TASK]: backfillCorpusIndexJobDetail,
  [RECONCILE_CASE_LAW_CORPUS_UPLOAD_INTENTS_TASK]:
    reconcileCaseLawCorpusUploadIntentsTask,
  [RECONCILE_CASE_LAW_RAW_SWEEPS_TASK]: reconcileCaseLawRawSweepsTask,
  [RECONCILE_CASE_LAW_RAW_ROWS_TASK]: reconcileCaseLawRawRowsTask,
  [CENSUS_CASE_LAW_RAW_OBJECTS_TASK]: censusCaseLawRawObjectsTask,
  [REFRESH_CASE_LAW_SITEMAP_SHARDS_TASK]: refreshCaseLawSitemapShardsTask,
  [REFRESH_CASE_LAW_BROWSE_FACETS_TASK]: refreshCaseLawBrowseFacetsTask,
  [REFRESH_CASE_LAW_SOURCE_ARRIVALS_TASK]: refreshCaseLawSourceArrivalsTask,
  [REFRESH_LEGISLATION_FACETS_TASK]: refreshLegislationFacetsTask,
  [REFRESH_STATUTE_SITEMAP_SHARDS_TASK]: refreshStatuteSitemapShardsTask,
  [RECONCILE_BUFFER_INTENTS_TASK]: reconcileBufferIntents,
  [SWEEP_FILE_COMPARISON_UPLOADS_TASK]: sweepFileComparisonUploads,
  [REPAIR_CHAT_SEARCH_INDEX_TASK]: repairChatSearchIndex,
  [REPAIR_SEARCH_PROJECTIONS_TASK]: repairSearchProjections,
  [CHAT_THREAD_COMPACTOR_TASK]: compactChatThreads,
  [SWEEP_CHAT_RUN_LOGS_TASK]: sweepChatRunLogs,
  [SWEEP_ACTION_COSTS_TASK]: sweepActionCostRecords,
  [SWEEP_REGISTRATIONS_TASK]: sweepRegistrationRecords,
  [PURGE_SYSTEM_AUDIT_RUNS_TASK]: purgeSystemAuditRunsTask,
  [BACKFILL_WORK_OBLIGATIONS_TASK]: backfillWorkObligations,
  [BACKFILL_LEGISLATION_EXPRESSION_IDS_TASK]: backfillLegislationExpressionIds,
  [WORK_ATTENTION_SCOUT_TASK]: runWorkAttentionScoutTask,
  [REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK]: repairSearchSemanticTimestampsTask,
  [MEMORY_CURATOR_TASK]: curateAiMemories,
  [MEMORY_EXTRACTOR_TASK]: extractMemoriesFromCompactions,
  [RECORD_MISSING_ORGANIZATION_ACCESS_STATES_TASK]:
    recordMissingOrganizationAccessStatesTask,
  [RECONCILE_ORGANIZATION_FILE_RESERVATIONS_TASK]:
    reconcileOrganizationFileReservations,
  // Ungated: its time-billing sample data admits itself on the feature.
  [RESET_REVIEW_ORGANIZATION_TASK]: resetReviewOrganizationTask,
  [CLEAN_TEMPLATE_DELETION_OBJECTS_TASK]: cleanTemplateDeletionObjects,
  [REPAIR_FILE_DERIVATIVES_TASK]: repairFileDerivatives,
  [RECONCILE_FLOW_RUN_ORPHANS_TASK]: reconcileFlowRunOrphans,
  [RECONCILE_DOCUMENT_REVIEW_RUNS_TASK]: reconcileDocumentReviewRuns,
  [RECONCILE_LIST_VERIFICATION_RUNS_TASK]: {
    featureId: "list-verification",
    task: reconcileListVerificationRuns,
  },
  [RECONCILE_BILINGUAL_RUNS_TASK]: reconcileBilingualRuns,
  [RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK]: reconcileStyleSetPackageCleanups,
  [RECONCILE_REPORT_EXPORTS_TASK]: reconcileReportExports,
  [RECOVER_DOCUMENT_DEADLINE_SCOUTS_TASK]: recoverDocumentDeadlineScouts,
} as const satisfies Record<
  string,
  SchedulerTask | { featureId: string; task: SchedulerTask }
>;

const schedulerTasks = (reapOwnerlessChatTurns: SchedulerTask) => ({
  ...SCHEDULER_TASKS,
  [REAP_OWNERLESS_CHAT_TURNS_TASK]: reapOwnerlessChatTurns,
});

export type RegisteredSchedulerTaskName = keyof ReturnType<
  typeof schedulerTasks
>;

/**
 * Every task name this build can execute, as data: job registration retires
 * persisted rows whose task no build code answers for anymore.
 */
export const REGISTERED_SCHEDULER_TASK_NAMES: ReadonlySet<string> = new Set(
  Object.keys(schedulerTasks(noopTask)),
);

export const createSchedulerTaskRegistry = (
  reapOwnerlessChatTurns: SchedulerTask,
): SchedulerTaskRegistry =>
  new Map(
    Object.entries(schedulerTasks(reapOwnerlessChatTurns)).map(
      ([name, entry]) => [
        name,
        typeof entry === "function" ? entry : entry.task,
      ],
    ),
  );
