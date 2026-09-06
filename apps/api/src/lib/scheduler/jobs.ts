import { panic } from "better-result";
import { and, eq, notInArray } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SchedulerPayload, SchedulerSchedule } from "@/api/db/schema";
import { schedulerJobs } from "@/api/db/schema";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { logger } from "@/api/lib/observability/logger";
import {
  REGISTERED_SCHEDULER_TASK_NAMES,
  type RegisteredSchedulerTaskName,
} from "@/api/lib/scheduler/registry";
import { computeNextRunAt } from "@/api/lib/scheduler/schedule";
import { RECONCILE_BILINGUAL_RUNS_TASK } from "@/api/lib/scheduler/tasks/bilingual-run-reconcile";
import { RECONCILE_BUFFER_INTENTS_TASK } from "@/api/lib/scheduler/tasks/buffer-intent-reconciliation";
import { RECONCILE_CASE_LAW_CORPUS_UPLOAD_INTENTS_TASK } from "@/api/lib/scheduler/tasks/case-law-corpus-upload-cleanup";
import { BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK } from "@/api/lib/scheduler/tasks/case-law-redaction-tombstone-backfill";
import { CHAT_THREAD_COMPACTOR_TASK } from "@/api/lib/scheduler/tasks/chat-thread-compactor";
import { BACKFILL_CORPUS_INDEX_JOB_DETAIL_TASK } from "@/api/lib/scheduler/tasks/corpus-index-job-detail-backfill";
import { EXPIRE_DESKTOP_EDIT_SESSIONS_TASK } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry";
import { RECOVER_DOCUMENT_DEADLINE_SCOUTS_TASK } from "@/api/lib/scheduler/tasks/document-deadline-scout-recovery";
import { DISPATCH_DOCUMENT_OCR_TASK } from "@/api/lib/scheduler/tasks/document-processing-ocr";
import { RECONCILE_DOCUMENT_REVIEW_RUNS_TASK } from "@/api/lib/scheduler/tasks/document-review-run-reconcile";
import { REPAIR_FILE_DERIVATIVES_TASK } from "@/api/lib/scheduler/tasks/file-derivative-repair";
import { RECONCILE_FLOW_RUN_ORPHANS_TASK } from "@/api/lib/scheduler/tasks/flow-run-orphan-reconcile";
import { INFO_SOUD_SYNC_TRACKED_CASES_TASK } from "@/api/lib/scheduler/tasks/infosoud";
import { MEMORY_CURATOR_TASK } from "@/api/lib/scheduler/tasks/memory-curator";
import { MEMORY_EXTRACTOR_TASK } from "@/api/lib/scheduler/tasks/memory-extractor";
import { RECONCILE_REPORT_EXPORTS_TASK } from "@/api/lib/scheduler/tasks/report-export-reconcile";
import { REPAIR_CHAT_SEARCH_INDEX_TASK } from "@/api/lib/scheduler/tasks/search-chat-index";
import { REPAIR_SEARCH_PROJECTIONS_TASK } from "@/api/lib/scheduler/tasks/search-projection-repair";
import { REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK } from "@/api/lib/scheduler/tasks/search-semantic-timestamps";
import { RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK } from "@/api/lib/scheduler/tasks/style-set-package-cleanup-reconcile";
import { CLEAN_TEMPLATE_DELETION_OBJECTS_TASK } from "@/api/lib/scheduler/tasks/template-deletion-cleanup";
import { WORK_ATTENTION_SCOUT_TASK } from "@/api/lib/scheduler/tasks/work-attention-scout";
import { BACKFILL_WORK_OBLIGATIONS_TASK } from "@/api/lib/scheduler/tasks/work-obligation-backfill";

type SchedulerJobDefinition = {
  id: string;
  task: RegisteredSchedulerTaskName;
  description: string;
  schedule: SchedulerSchedule;
  payload?: SchedulerPayload | null;
  payloadUpdate?: "preserve" | "replace";
  enabled?: boolean;
};

export const ensureSchedulerJob = async ({
  description,
  enabled = true,
  id,
  payload = null,
  payloadUpdate = "replace",
  schedule,
  task,
}: SchedulerJobDefinition): Promise<void> => {
  const nextRunAt = computeNextRunAt(schedule);
  const [existingJob] = await rootDb
    .select({
      schedule: schedulerJobs.schedule,
      task: schedulerJobs.task,
    })
    .from(schedulerJobs)
    .where(eq(schedulerJobs.id, id))
    .limit(1);
  const shouldRefreshNextRunAt =
    !existingJob ||
    existingJob.task !== task ||
    !sameSchedule(existingJob.schedule, schedule);

  await rootDb
    .insert(schedulerJobs)
    .values({
      description,
      enabled,
      id,
      nextRunAt,
      payload,
      schedule,
      task,
    })
    .onConflictDoUpdate({
      target: schedulerJobs.id,
      set: {
        description,
        enabled,
        ...(shouldRefreshNextRunAt && { nextRunAt }),
        ...(payloadUpdate === "replace" && { payload }),
        schedule,
        task,
      },
    });
};

const ensureOneShotSchedulerJob = async ({
  description,
  id,
  payload = null,
  schedule,
  task,
}: Omit<SchedulerJobDefinition, "enabled">): Promise<void> => {
  await rootDb
    .insert(schedulerJobs)
    .values({
      description,
      enabled: true,
      id,
      nextRunAt: computeNextRunAt(schedule),
      payload,
      schedule,
      task,
    })
    .onConflictDoNothing({ target: schedulerJobs.id });
};

const sameSchedule = (
  left: SchedulerSchedule,
  right: SchedulerSchedule,
): boolean => {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "interval" && right.type === "interval") {
    return left.everyMs === right.everyMs;
  }

  if (left.type !== "daily" || right.type !== "daily") {
    return false;
  }

  return (
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.timeZone === right.timeZone
  );
};

/**
 * How a declared job is registered. `oneShot` jobs retire themselves once
 * their backfill completes, so a missing row is expected for them and only
 * `recurring` ids are asserted present after registration.
 */
type SchedulerJobMode = "recurring" | "oneShot";

type DeclaredSchedulerJob = SchedulerJobDefinition & { mode: SchedulerJobMode };

/**
 * Every job this deployment is expected to run, as data rather than as a
 * sequence of calls.
 *
 * The declaration being a value is what lets boot compare it against what is
 * actually registered. A job that exists only as code nobody runs produces no
 * error, no log and no metric — the failure is indistinguishable from "there
 * was no work to do" — so the set has to be checkable from outside the loop.
 */
export const DECLARED_SCHEDULER_JOBS = [
  {
    description: "Release queued PDFs to the searchable-text worker",
    id: "documentProcessing.dispatchOcr.configuredInterval",
    mode: "recurring",
    schedule: {
      type: "interval",
      everyMs: envBase.DOCUMENT_OCR_BATCH_INTERVAL_MINUTES * 60_000,
    },
    task: DISPATCH_DOCUMENT_OCR_TASK,
  },
  {
    description: "Dispatch document deadline scouts nothing has picked up",
    id: "documentProcessing.recoverDeadlineScouts.fiveMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: RECOVER_DOCUMENT_DEADLINE_SCOUTS_TASK,
  },
  {
    description:
      "Reconcile abandoned server-generated entity and version objects",
    id: "entityBuffers.reconcileIntents.minutely",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 60 * 1000 },
    task: RECONCILE_BUFFER_INTENTS_TASK,
  },
  {
    description: "Delete corpus objects from cancelled case-law uploads",
    id: "caseLaw.reconcileCorpusUploadIntents.minutely",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 60 * 1000 },
    task: RECONCILE_CASE_LAW_CORPUS_UPLOAD_INTENTS_TASK,
  },
  {
    description:
      "Backfill durable case-law redaction tombstones and search cleanup",
    id: "caseLaw.backfillRedactionTombstones.v2",
    mode: "oneShot",
    schedule: { type: "interval", everyMs: 60 * 1000 },
    task: BACKFILL_CASE_LAW_REDACTION_TOMBSTONES_TASK,
  },
  {
    description:
      "Move withdrawal reasons from the index-job failure column to detail",
    id: "corpusIndex.backfillJobDetail.v1",
    mode: "oneShot",
    schedule: { type: "interval", everyMs: 60 * 1000 },
    task: BACKFILL_CORPUS_INDEX_JOB_DETAIL_TASK,
  },
  {
    description: "Periodically repair governed work rows for legacy tasks",
    enabled: env.FEATURE_GOVERNED_WORKFLOW,
    id: "workObligations.backfillLegacyTasks.v1",
    mode: "recurring",
    payloadUpdate: "preserve",
    schedule: { type: "interval", everyMs: 60 * 1000 },
    task: BACKFILL_WORK_OBLIGATIONS_TASK,
  },
  {
    description: "Surface stuck and at-risk governed work as inbox signals",
    enabled: env.FEATURE_GOVERNED_WORKFLOW,
    id: "workObligations.attentionScout.hourly",
    mode: "recurring",
    payloadUpdate: "preserve",
    schedule: { type: "interval", everyMs: 60 * 60 * 1000 },
    task: WORK_ATTENTION_SCOUT_TASK,
  },
  {
    description: "Repair stale chat search projections",
    id: "search.repairChatIndex.fiveMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: REPAIR_CHAT_SEARCH_INDEX_TASK,
  },
  {
    description:
      "Drain the entity, contact, and matter search projection repair queue",
    id: "search.repairProjections.oneMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 60 * 1000 },
    task: REPAIR_SEARCH_PROJECTIONS_TASK,
  },
  {
    description: "Re-enqueue flow-run steps no queued job owns anymore",
    id: "flows.reconcileOrphanRuns.fiveMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: RECONCILE_FLOW_RUN_ORPHANS_TASK,
  },
  {
    description: "Re-drive file derivatives no queued job owns anymore",
    id: "files.repairDerivatives.fiveMinute",
    mode: "recurring",
    payloadUpdate: "preserve",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: REPAIR_FILE_DERIVATIVES_TASK,
  },
  {
    description: "Re-drive document review runs no queued job owns anymore",
    id: "documentReviews.reconcileQueuedRuns.fiveMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: RECONCILE_DOCUMENT_REVIEW_RUNS_TASK,
  },
  {
    description:
      "Re-drive bilingual translation runs no queued job owns anymore",
    id: "bilingualTranslations.reconcileQueuedRuns.fiveMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: RECONCILE_BILINGUAL_RUNS_TASK,
  },
  {
    description:
      "Re-drive report exports no queued job owns anymore, and fail the ones that outlived it",
    id: "reportExports.reconcileQueued.fiveMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: RECONCILE_REPORT_EXPORTS_TASK,
  },
  {
    description: "Delete style set packages a replacement left behind",
    id: "styleSets.reconcilePackageCleanups.fiveMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 5 * 60 * 1000 },
    task: RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK,
  },
  {
    description: "Delete template objects recorded by committed deletions",
    id: "templates.cleanDeletionObjects.oneMinute",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 60 * 1000 },
    task: CLEAN_TEMPLATE_DELETION_OBJECTS_TASK,
  },
  {
    description:
      "Repair entity search timestamps and persisted preview passages",
    id: "search.repairSemanticTimestamps.v2",
    mode: "oneShot",
    schedule: { type: "interval", everyMs: 60_000 },
    task: REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK,
  },
  {
    description: "Sync tracked InfoSoud cases into matter agenda",
    id: "infosoud.syncTrackedCases.nightly",
    mode: "recurring",
    schedule: {
      type: "daily",
      hour: 3,
      minute: 0,
      timeZone: "Europe/Prague",
    },
    task: INFO_SOUD_SYNC_TRACKED_CASES_TASK,
  },
  {
    description: "Expire abandoned desktop edit sessions past their token TTL",
    id: "desktopEditSessions.expire.hourly",
    mode: "recurring",
    schedule: { type: "interval", everyMs: 60 * 60 * 1000 },
    task: EXPIRE_DESKTOP_EDIT_SESSIONS_TASK,
  },
  {
    description:
      "Age AI memories through the active -> stale -> archived lifecycle",
    enabled: env.FEATURE_AI_MEMORY,
    id: "memory.curator.nightly",
    mode: "recurring",
    schedule: {
      type: "daily",
      hour: 2,
      minute: 0,
      timeZone: "Europe/Prague",
    },
    task: MEMORY_CURATOR_TASK,
  },
  {
    description:
      "Extract suggested AI memories from new chat-thread compactions",
    enabled: env.FEATURE_AI_MEMORY,
    id: "memory.extractor.hourly",
    mode: "recurring",
    schedule: {
      type: "interval",
      everyMs: 60 * 60 * 1000,
    },
    task: MEMORY_EXTRACTOR_TASK,
  },
  {
    description:
      "Fold new chat-thread messages into their durable compaction checkpoint",
    id: "chat.compactThreads.everyFiveMinutes",
    mode: "recurring",
    schedule: {
      type: "interval",
      everyMs: 5 * 60 * 1000,
    },
    task: CHAT_THREAD_COMPACTOR_TASK,
  },
] as const satisfies readonly DeclaredSchedulerJob[];

/**
 * Register every declared job, then verify the registration actually landed.
 *
 * The verification is the point. An empty `scheduler_jobs` table is exactly
 * what a deployment with no scheduler process looks like, and a staleness
 * check over its rows passes vacuously in that state: zero rows means zero
 * stale rows. Comparing against the declared set is what makes "nothing is
 * registered" loud instead of silent.
 */
export const ensureDefaultSchedulerJobs = async (): Promise<void> => {
  for (const { mode, ...definition } of DECLARED_SCHEDULER_JOBS) {
    // Sequential on purpose: each upsert is a read followed by a write, so
    // issuing all of them at once puts more concurrent statements in flight
    // than the root pool holds, and registration is on no latency path.
    // Bounded by the declared list.
    await (mode === "oneShot"
      ? ensureOneShotSchedulerJob(definition)
      : ensureSchedulerJob(definition));
  }

  const registered = new Set(
    (await rootDb.select({ id: schedulerJobs.id }).from(schedulerJobs)).map(
      ({ id }) => id,
    ),
  );
  const missing = DECLARED_SCHEDULER_JOBS.filter(
    ({ id, mode }) => mode === "recurring" && !registered.has(id),
  ).map(({ id }) => id);

  if (missing.length > 0) {
    panic(`scheduler jobs declared but not registered: ${missing.join(", ")}`);
  }

  // A persisted job whose task this build cannot run is undrivable: the
  // scheduler would keep claiming it and executing nothing, invisibly. Rows
  // reach that state when a deployment removes a task, because the loop
  // above only upserts declared jobs and never retires what an older build
  // declared. The registry is the discriminator, not the declared list, so
  // dynamically registered jobs (scheduled flows) are untouched. Disable
  // rather than delete: the row remains as an audit record, and a
  // rollback's own registration re-enables it (the upsert sets `enabled`).
  // One guarded update, so a concurrent change to a row's task or enabled
  // state cannot be overwritten from a stale read; only rows the update
  // actually changed are logged.
  const retired = await rootDb
    .update(schedulerJobs)
    .set({ enabled: false })
    .where(
      and(
        eq(schedulerJobs.enabled, true),
        notInArray(schedulerJobs.task, [...REGISTERED_SCHEDULER_TASK_NAMES]),
      ),
    )
    .returning({ id: schedulerJobs.id, task: schedulerJobs.task });
  for (const { id, task } of retired) {
    logger.warn("scheduler.job_retired", { jobId: id, task });
  }
};
