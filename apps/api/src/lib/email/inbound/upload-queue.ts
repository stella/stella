import { Result, TaggedError } from "better-result";

import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  fileUploadedMail,
  UploadedMailUnavailableError,
} from "@/api/lib/email/inbound/upload";
import {
  UPLOADED_MAIL_QUEUE_NAME,
  type UploadedMailJobData,
} from "@/api/lib/email/inbound/upload-enqueue";
import { resolveLegacyUploadedMailSource } from "@/api/lib/email/inbound/upload-source";
import type {
  LegacyUploadedMailJobData,
  UploadedMailSource,
} from "@/api/lib/email/inbound/upload-source";
import { createFileKey } from "@/api/lib/file-key";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import {
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
  brandPersistedFieldId,
  brandPersistedOrganizationId,
  brandPersistedUserFileId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const FILING_FAILED_SINK = failureSink({
  event: "correspondence.upload.filing_failed",
  expected: [],
});

type FileDatabase = Parameters<typeof fileUploadedMail>[0]["database"];

/** Jobs from the previous release stay queued, and are produced, mid-rollout. */
type QueuedUploadedMailJobData =
  UploadedMailJobData | LegacyUploadedMailJobData;

type ProcessUploadedMailJobOptions = {
  data: QueuedUploadedMailJobData;
  database: FileDatabase;
  readFile?: typeof readStoredFile;
  fileMail?: typeof fileUploadedMail;
};

/**
 * A previous-release job whose file no stored version names. It fails the
 * attempt, so BullMQ retries it and an exhausted job stays in the failed set
 * and is reported as a sustained filing failure.
 */
export class UploadedMailSourceUnresolvedError extends TaggedError(
  "UploadedMailSourceUnresolvedError",
)<{ message: string }> {}

const isLegacyJob = (
  data: QueuedUploadedMailJobData,
): data is LegacyUploadedMailJobData => !("entityVersionId" in data);

const queuedSource = (data: UploadedMailJobData): UploadedMailSource => ({
  organizationId: brandPersistedOrganizationId(data.organizationId),
  workspaceId: brandPersistedWorkspaceId(data.workspaceId),
  entityId: brandPersistedEntityId(data.entityId),
  entityVersionId: brandPersistedEntityVersionId(data.entityVersionId),
  fieldId: brandPersistedFieldId(data.fieldId),
  sourceFileId: brandPersistedUserFileId(data.sourceFileId),
  sourceSha256Hex: data.sourceSha256Hex,
  storageMimeType: data.storageMimeType,
  extractionMimeType: data.extractionMimeType,
});

const resolveQueuedSource = async (
  data: QueuedUploadedMailJobData,
  database: FileDatabase,
): Promise<
  Result<
    UploadedMailSource,
    UploadedMailSourceUnresolvedError | UploadedMailUnavailableError
  >
> => {
  if (!isLegacyJob(data)) {
    return Result.ok(queuedSource(data));
  }
  // Remove this branch once no previous-release producer can be running.
  const resolved = await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(
        database,
        async (tx) => await resolveLegacyUploadedMailSource(tx, data),
      ),
    catch: (cause) =>
      new UploadedMailUnavailableError({
        message: "Uploaded correspondence source could not be read",
        cause,
      }),
  });
  if (resolved.isErr()) {
    return resolved;
  }
  return resolved.value === null
    ? Result.err(
        new UploadedMailSourceUnresolvedError({
          message: `No stored version of entity ${data.entityId} names uploaded file ${data.sourceFileId}; re-run its extraction to queue the filing again`,
        }),
      )
    : Result.ok(resolved.value);
};

const fileQueuedMail = async ({
  data,
  database,
  readFile = readStoredFile,
  fileMail = fileUploadedMail,
}: ProcessUploadedMailJobOptions) => {
  const resolved = await resolveQueuedSource(data, database);
  if (resolved.isErr()) {
    return resolved;
  }
  const source = resolved.value;
  const stored = await readFile({
    key: createFileKey({
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
      fileId: source.sourceFileId,
      mimeType: source.storageMimeType,
    }),
    mimeType: source.extractionMimeType,
    scope: {
      organizationId: source.organizationId,
      workspaceId: source.workspaceId,
    },
    signal: AbortSignal.timeout(LIMITS.documentProcessingObjectReadTimeoutMs),
  });
  return await fileMail({
    bytes: stored.bytes,
    source,
    database,
  });
};

/**
 * One filing attempt. An unavailable database or object read rejects, so
 * BullMQ retries with backoff; the file's unique record makes a retry after an
 * uncertain commit converge as a duplicate. A permanent refusal is a terminal
 * skip.
 */
export const processUploadedMailJob = async (
  options: ProcessUploadedMailJobOptions,
) => {
  const filed = await fileQueuedMail(options);
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
  const worker = new BullMqWorker<QueuedUploadedMailJobData>(
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
