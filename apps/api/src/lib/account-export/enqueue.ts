import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";

export const ACCOUNT_EXPORT_QUEUE_NAME = "account-exports";
const JOB_NAME = "build-account-export";

export type AccountExportJob = { id: string };

const getQueue = createLazyBullMqQueue<AccountExportJob>({
  name: ACCOUNT_EXPORT_QUEUE_NAME,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** PostgreSQL remains the source of truth if the transport is unavailable. */
export const enqueueAccountExport = async (id: string): Promise<void> => {
  await requeueDeterministicJob({
    queue: getQueue(),
    data: { id },
    jobId: createBullMqJobId(id, JOB_NAME),
    name: JOB_NAME,
  });
};
