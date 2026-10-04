import { Result } from "better-result";
import { Worker } from "bullmq";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { fileUploadedMail } from "@/api/lib/email/inbound/upload";
import { errorTag } from "@/api/lib/errors/utils";
import { createFileKey } from "@/api/lib/file-key";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import {
  brandPersistedEntityId,
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const QUEUE_NAME = "uploaded-mail-correspondence";
const JOB_NAME = "file-uploaded-mail";
const JOB_ATTEMPTS = 6;

/**
 * Names the stored file, not its bytes: the job reads the object again, so a
 * retry needs no copy of the message in the queue.
 */
type UploadedMailJobData = {
  organizationId: string;
  workspaceId: string;
  entityId: string;
  sourceFileId: string;
  storageMimeType: string;
  mimeType: string;
};

type UploadedMailQueue = RequeueableQueue<UploadedMailJobData>;

const getQueue = createLazyBullMqQueue<UploadedMailJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

type FileDatabase = Parameters<typeof fileUploadedMail>[0]["database"];

type FileUploadedMailOrRetryOptions = {
  bytes: ArrayBuffer;
  file: {
    sourceFileId: string;
    storageMimeType: string;
    mimeType: string;
  };
  scope: {
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace">;
    entityId: SafeId<"entity">;
  };
  database: FileDatabase;
  fileMail?: typeof fileUploadedMail;
  queue?: UploadedMailQueue;
};

/**
 * Files an email file from the extraction run that already holds its bytes.
 * A permanent refusal is a terminal skip. An unavailable database hands the
 * file to a retrying job keyed by the file, so extraction itself never fails
 * on this step and a repeated hand-off collapses onto one job.
 */
export const fileUploadedMailOrRetry = async ({
  bytes,
  file,
  scope,
  database,
  fileMail = fileUploadedMail,
  queue,
}: FileUploadedMailOrRetryOptions) => {
  const filed = await fileMail({
    bytes,
    mimeType: file.mimeType,
    scope,
    database,
  });
  if (filed.isOk()) {
    return Result.ok(filed.value);
  }
  logger.warn("correspondence.upload.retry_scheduled", {
    "error.type": errorTag(filed.error),
  });
  const data = { ...scope, ...file } satisfies UploadedMailJobData;
  return await Result.tryPromise({
    try: async () => {
      await requeueDeterministicJob({
        data,
        jobId: createBullMqJobId(JOB_NAME, scope.entityId, file.sourceFileId),
        name: JOB_NAME,
        // The queue connection opens only when a retry is needed.
        queue: queue ?? getQueue(),
      });
      return { status: "retry_scheduled" as const };
    },
    catch: (cause) => cause,
  });
};

type ProcessUploadedMailJobOptions = {
  data: UploadedMailJobData;
  database: FileDatabase;
  readFile?: typeof readStoredFile;
  fileMail?: typeof fileUploadedMail;
};

/**
 * One retry attempt. An unavailable database or object read rejects, so
 * BullMQ retries with backoff; the file's unique record makes a retry after an
 * uncertain commit converge as a duplicate.
 */
export const processUploadedMailJob = async ({
  data,
  database,
  readFile = readStoredFile,
  fileMail = fileUploadedMail,
}: ProcessUploadedMailJobOptions) => {
  const scope = {
    organizationId: brandPersistedOrganizationId(data.organizationId),
    workspaceId: brandPersistedWorkspaceId(data.workspaceId),
    entityId: brandPersistedEntityId(data.entityId),
  };
  const stored = await readFile({
    key: createFileKey({
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      fileId: data.sourceFileId,
      mimeType: data.storageMimeType,
    }),
    mimeType: data.mimeType,
    scope: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    },
    signal: AbortSignal.timeout(LIMITS.documentProcessingObjectReadTimeoutMs),
  });
  const filed = await fileMail({
    bytes: stored.bytes,
    mimeType: data.mimeType,
    scope,
    database,
  });
  if (filed.isErr()) {
    throw filed.error;
  }
  return filed.value;
};

type FailedUploadedMailJob = {
  attemptsMade: number;
  opts: { attempts?: number | undefined };
  data: Pick<UploadedMailJobData, "entityId">;
};

/** A failed attempt is retried; only an exhausted job reaches telemetry. */
export const reportUploadedMailJobFailure = ({
  job,
  error,
  capture = captureError,
}: {
  job: FailedUploadedMailJob | undefined;
  error: unknown;
  capture?: typeof captureError;
}) => {
  if (job !== undefined && job.attemptsMade < (job.opts.attempts ?? 1)) {
    logger.warn("correspondence.upload.retry_failed", {
      "error.type": errorTag(error),
      attempt: String(job.attemptsMade),
    });
    return "retrying" as const;
  }
  capture(error, {
    queue: QUEUE_NAME,
    entityId: job?.data.entityId ?? "unknown",
  });
  return "exhausted" as const;
};

export const initUploadedMailCorrespondenceWorker = ({
  db,
}: BullMqWorkerContext) => {
  const workerConnection = createBullMqConnection({
    storeClass: "durable-coordination",
  });
  const worker = new Worker<UploadedMailJobData>(
    QUEUE_NAME,
    async (job) => {
      await processUploadedMailJob({ data: job.data, database: db });
    },
    { connection: workerConnection },
  );

  worker.on("failed", (job, error) => {
    reportUploadedMailJobFailure({ job, error });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("uploaded_mail_correspondence.worker_error"),
  );

  return {
    queues: [QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
    },
  };
};
