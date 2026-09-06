import { createBullMqDispatchTask } from "@/api/lib/scheduler/bullmq";
import {
  RECONCILE_BILINGUAL_RUNS_TASK,
  reconcileBilingualRuns,
} from "@/api/lib/scheduler/tasks/bilingual-run-reconcile";
import {
  RECONCILE_BUFFER_INTENTS_TASK,
  reconcileBufferIntents,
} from "@/api/lib/scheduler/tasks/buffer-intent-reconciliation";
import {
  RECONCILE_CASE_LAW_CORPUS_UPLOAD_INTENTS_TASK,
  reconcileCaseLawCorpusUploadIntentsTask,
} from "@/api/lib/scheduler/tasks/case-law-corpus-upload-cleanup";
import {
  BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  backfillCaseLawRedactionTombstones,
} from "@/api/lib/scheduler/tasks/case-law-redaction-tombstone-backfill";
import {
  CHAT_THREAD_COMPACTOR_TASK,
  compactChatThreads,
} from "@/api/lib/scheduler/tasks/chat-thread-compactor";
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
  INFO_SOUD_SYNC_TRACKED_CASES_TASK,
  syncInfoSoudTrackedCases,
} from "@/api/lib/scheduler/tasks/infosoud";
import {
  MEMORY_CURATOR_TASK,
  curateAiMemories,
} from "@/api/lib/scheduler/tasks/memory-curator";
import {
  MEMORY_EXTRACTOR_TASK,
  extractMemoriesFromCompactions,
} from "@/api/lib/scheduler/tasks/memory-extractor";
import {
  RECONCILE_REPORT_EXPORTS_TASK,
  reconcileReportExports,
} from "@/api/lib/scheduler/tasks/report-export-reconcile";
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
  RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK,
  reconcileStyleSetPackageCleanups,
} from "@/api/lib/scheduler/tasks/style-set-package-cleanup-reconcile";
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
  "scheduler.noop": noopTask,
  "scheduler.dispatchBullMq": createBullMqDispatchTask(),
  [INFO_SOUD_SYNC_TRACKED_CASES_TASK]: syncInfoSoudTrackedCases,
  [EXPIRE_DESKTOP_EDIT_SESSIONS_TASK]: expireDesktopEditSessions,
  [DISPATCH_DOCUMENT_OCR_TASK]: dispatchDocumentOcr,
  [FLOW_RUN_TASK]: runScheduledFlow,
  [BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK]:
    backfillCaseLawRedactionTombstones,
  [BACKFILL_CORPUS_INDEX_JOB_DETAIL_TASK]: backfillCorpusIndexJobDetail,
  [RECONCILE_CASE_LAW_CORPUS_UPLOAD_INTENTS_TASK]:
    reconcileCaseLawCorpusUploadIntentsTask,
  [RECONCILE_BUFFER_INTENTS_TASK]: reconcileBufferIntents,
  [REPAIR_CHAT_SEARCH_INDEX_TASK]: repairChatSearchIndex,
  [REPAIR_SEARCH_PROJECTIONS_TASK]: repairSearchProjections,
  [CHAT_THREAD_COMPACTOR_TASK]: compactChatThreads,
  [BACKFILL_WORK_OBLIGATIONS_TASK]: backfillWorkObligations,
  [WORK_ATTENTION_SCOUT_TASK]: runWorkAttentionScoutTask,
  [REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK]: repairSearchSemanticTimestampsTask,
  [MEMORY_CURATOR_TASK]: curateAiMemories,
  [MEMORY_EXTRACTOR_TASK]: extractMemoriesFromCompactions,
  [CLEAN_TEMPLATE_DELETION_OBJECTS_TASK]: cleanTemplateDeletionObjects,
  [REPAIR_FILE_DERIVATIVES_TASK]: repairFileDerivatives,
  [RECONCILE_FLOW_RUN_ORPHANS_TASK]: reconcileFlowRunOrphans,
  [RECONCILE_DOCUMENT_REVIEW_RUNS_TASK]: reconcileDocumentReviewRuns,
  [RECONCILE_BILINGUAL_RUNS_TASK]: reconcileBilingualRuns,
  [RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK]: reconcileStyleSetPackageCleanups,
  [RECONCILE_REPORT_EXPORTS_TASK]: reconcileReportExports,
  [RECOVER_DOCUMENT_DEADLINE_SCOUTS_TASK]: recoverDocumentDeadlineScouts,
} as const satisfies Record<string, SchedulerTask>;

export type RegisteredSchedulerTaskName = keyof typeof SCHEDULER_TASKS;

/**
 * Every task name this build can execute, as data: job registration retires
 * persisted rows whose task no build code answers for anymore.
 */
export const REGISTERED_SCHEDULER_TASK_NAMES: ReadonlySet<string> = new Set(
  Object.keys(SCHEDULER_TASKS),
);

export const createSchedulerTaskRegistry = (): SchedulerTaskRegistry =>
  new Map<string, SchedulerTask>(Object.entries(SCHEDULER_TASKS));
