import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { fileUploadedMail } from "@/api/lib/email/inbound/upload";
import {
  UPLOADED_MAIL_QUEUE_NAME,
  type UploadedMailJobData,
} from "@/api/lib/email/inbound/upload-enqueue";
import { createFileKey } from "@/api/lib/file-key";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import {
  brandPersistedEntityId,
  brandPersistedOrganizationId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const FILING_FAILED_SINK = failureSink({
  event: "correspondence.upload.filing_failed",
  expected: [],
});

type FileDatabase = Parameters<typeof fileUploadedMail>[0]["database"];

type ProcessUploadedMailJobOptions = {
  data: UploadedMailJobData;
  database: FileDatabase;
  readFile?: typeof readStoredFile;
  fileMail?: typeof fileUploadedMail;
};

/**
 * One filing attempt. An unavailable database or object read rejects, so
 * BullMQ retries with backoff; the file's unique record makes a retry after an
 * uncertain commit converge as a duplicate. A permanent refusal is a terminal
 * skip.
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

/**
 * Every failed attempt is observed and graded by its cause; an exhausted job
 * is a sustained episode, which raises a transient failure's severity.
 */
export const reportUploadedMailJobFailure = ({
  job,
  error,
  observe = observeFailure,
}: {
  job: FailedUploadedMailJob | undefined;
  error: unknown;
  observe?: typeof observeFailure;
}) => {
  const ctx = {
    queue: UPLOADED_MAIL_QUEUE_NAME,
    entityId: job?.data.entityId ?? "unknown",
  };
  if (job !== undefined && job.attemptsMade < (job.opts.attempts ?? 1)) {
    observe(error, { sink: FILING_FAILED_SINK, ctx });
    return "retrying" as const;
  }
  observe(error, { sink: FILING_FAILED_SINK, ctx, escalation: "sustained" });
  return "exhausted" as const;
};

export const initUploadedMailCorrespondenceWorker = ({
  db,
}: BullMqWorkerContext) => {
  const workerConnection = createBullMqConnection({
    storeClass: "durable-coordination",
  });
  const worker = new BullMqWorker<UploadedMailJobData>(
    UPLOADED_MAIL_QUEUE_NAME,
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
    queues: [UPLOADED_MAIL_QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
    },
  };
};
