import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";

// The document-processing worker enqueues through this module, so it must not
// import the filing code: that graph reaches the API environment.
export const UPLOADED_MAIL_QUEUE_NAME = "uploaded-mail-correspondence";
const JOB_NAME = "file-uploaded-mail";
const JOB_ATTEMPTS = 6;

/**
 * Names the stored file, not its bytes: the job reads the object again, so the
 * queue holds no copy of the message.
 */
export type UploadedMailJobData = {
  organizationId: string;
  workspaceId: string;
  entityId: string;
  entityVersionId: string;
  fieldId: string;
  sourceFileId: string;
  sourceSha256Hex: string;
  storageMimeType: string;
  extractionMimeType: string;
  /**
   * The extraction type under the name previous-release workers read. Remove
   * it once no previous-release worker can consume this queue.
   */
  mimeType?: string;
};

type UploadedMailQueue = RequeueableQueue<UploadedMailJobData>;

const getQueue = createLazyBullMqQueue<UploadedMailJobData>({
  name: UPLOADED_MAIL_QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

type EnqueueUploadedMailFilingOptions = {
  file: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
    storageMimeType: string;
    extractionMimeType: string;
  };
  scope: {
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace">;
    entityId: SafeId<"entity">;
  };
  queue?: UploadedMailQueue;
};

/**
 * Hands a stored email file to the filing job. The job id names the admitted
 * version and file, so a replayed extraction run collapses onto one job while
 * a newer version cannot be mistaken for the queued source.
 */
export const enqueueUploadedMailFiling = async ({
  file,
  scope,
  queue,
}: EnqueueUploadedMailFilingOptions): Promise<void> => {
  await requeueDeterministicJob({
    data: { ...scope, ...file, mimeType: file.extractionMimeType },
    jobId: createBullMqJobId(
      JOB_NAME,
      scope.entityId,
      file.entityVersionId,
      file.sourceFileId,
    ),
    name: JOB_NAME,
    // The queue connection opens only when an email file is extracted.
    queue: queue ?? getQueue(),
  });
};
