import { eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SchedulerPayload, SchedulerSchedule } from "@/api/db/schema";
import { schedulerJobs } from "@/api/db/schema";
import { computeNextRunAt } from "@/api/lib/scheduler/schedule";
import { BACKFILL_SK_DOCUMENTS_TASK } from "@/api/lib/scheduler/tasks/case-law-sk-documents";
import { EXPIRE_DESKTOP_EDIT_SESSIONS_TASK } from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry";
import { INFO_SOUD_SYNC_TRACKED_CASES_TASK } from "@/api/lib/scheduler/tasks/infosoud";

type SchedulerJobDefinition = {
  id: string;
  task: string;
  description: string;
  schedule: SchedulerSchedule;
  payload?: SchedulerPayload | null;
  enabled?: boolean;
};

export const ensureSchedulerJob = async ({
  description,
  enabled = true,
  id,
  payload = null,
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
        payload,
        schedule,
        task,
      },
    });
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

export const ensureDefaultSchedulerJobs = async (): Promise<void> => {
  await ensureSchedulerJob({
    description: "Sync tracked InfoSoud cases into matter agenda",
    id: "infosoud.syncTrackedCases.nightly",
    schedule: {
      type: "daily",
      hour: 3,
      minute: 0,
      timeZone: "Europe/Prague",
    },
    task: INFO_SOUD_SYNC_TRACKED_CASES_TASK,
  });

  await ensureSchedulerJob({
    description: "Expire abandoned desktop edit sessions past their token TTL",
    id: "desktopEditSessions.expire.hourly",
    schedule: {
      type: "interval",
      everyMs: 60 * 60 * 1000,
    },
    task: EXPIRE_DESKTOP_EDIT_SESSIONS_TASK,
  });

  // Every 15 minutes rather than nightly: the queue grows with each
  // ingested page, and a decision sitting in it has no readable text.
  // One batch is ~40 PDFs, so this keeps pace with the crawl without
  // ever putting a burst on the court's site.
  await ensureSchedulerJob({
    description: "Fetch and parse PDFs for Slovak court decisions",
    id: "caseLaw.backfillSkDocuments.quarterHourly",
    schedule: {
      type: "interval",
      everyMs: 15 * 60 * 1000,
    },
    task: BACKFILL_SK_DOCUMENTS_TASK,
  });
};
