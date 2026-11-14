/**
 * Queue identity and object layout for organisation data exports: the queue
 * name, the job payload, the handoff, and where an export's files live.
 *
 * Separate from the worker so the request handler and the scheduler can
 * enqueue without importing the archive builder.
 *
 * The application never deletes export objects: the API role may not delete
 * under `exports/`, and the bucket lifecycle is the deletion mechanism. It
 * expires every object there a week after creation and aborts unfinished
 * multipart uploads after a day, so a part abandoned by a failed attempt,
 * or rewritten by a resumed one, ages out on its own.
 */

import { DAY_IN_MS } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";
import type { QueueRequeueOutcome } from "@/api/lib/bullmq-requeue";

export const DATA_EXPORT_QUEUE_NAME = "organization-data-exports";
const DATA_EXPORT_JOB_NAME = "export-organization-data";

/**
 * How long an export stays downloadable, counted from when its run started:
 * every object it wrote is younger than that, so the bucket's own expiry of
 * the same age never removes a file the export still offers.
 */
export const DATA_EXPORT_RETENTION_MS = 7 * DAY_IN_MS;

/** Lifetime of one download link; Range requests resume within it. */
export const DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Target size of one part ZIP. */
export const DATA_EXPORT_PART_TARGET_BYTES = 2 * 1024 ** 3;

/**
 * Exports running at once across every API process. Each process runs at
 * most one; this caps the total so storage and database load stay a small,
 * fixed share however many organisations export together.
 */
export const DATA_EXPORT_GLOBAL_CONCURRENCY = 2;

/** A running export whose heartbeat is older than this lost its worker. */
export const DATA_EXPORT_HEARTBEAT_STALE_MS = 15 * 60 * 1000;

export type DataExportJobData = {
  exportId: string;
  organizationId: string;
  userId: string;
};

// BullMQ never retries: an attempt that stops is handed back as `queued`
// with its checkpoints, and the maintenance sweep enqueues the next attempt,
// which resumes at the first unfinished part.
export const getDataExportQueue = createLazyBullMqQueue<DataExportJobData>({
  name: DATA_EXPORT_QUEUE_NAME,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

type EnqueueDataExportArgs = {
  exportId: SafeId<"dataExport">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The export's attempt counter; each resume gets a job of its own. */
  attempt: number;
};

/** Idempotent per export attempt: the job id derives from both. */
export const enqueueDataExport = async ({
  exportId,
  organizationId,
  userId,
  attempt,
}: EnqueueDataExportArgs): Promise<QueueRequeueOutcome> =>
  await requeueDeterministicJob({
    data: { exportId, organizationId, userId },
    jobId: createBullMqJobId(organizationId, exportId, String(attempt)),
    name: DATA_EXPORT_JOB_NAME,
    queue: getDataExportQueue(),
  });

/**
 * Object-key prefix holding every file of one export. It sits under the
 * root `exports/` prefix: the bucket's lifecycle rule there deletes objects
 * a week after creation (the only deletion mechanism), and the `exports`
 * signing keyspace scopes download URLs to the organisation.
 */
export const dataExportPrefix = ({
  organizationId,
  exportId,
}: {
  organizationId: SafeId<"organization">;
  exportId: SafeId<"dataExport">;
}): string => `exports/${organizationId}/data-exports/${exportId}/`;

type DataExportObjectKeyOptions = {
  organizationId: SafeId<"organization">;
  exportId: SafeId<"dataExport">;
  /** The attempt whose upload holds the bytes. */
  attempt: number;
  fileName: string;
};

/**
 * Each attempt writes under its own keys, so an upload a superseded attempt
 * completes late never replaces an object a newer attempt published. The
 * export row records which attempt holds each file.
 */
export const dataExportObjectKey = ({
  organizationId,
  exportId,
  attempt,
  fileName,
}: DataExportObjectKeyOptions): string =>
  `${dataExportPrefix({ organizationId, exportId })}attempt-${String(attempt)}/${fileName}`;

export const DATA_EXPORT_MANIFEST_FILE_NAME = "export-manifest.json";
