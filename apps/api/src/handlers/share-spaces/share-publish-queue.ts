import { Result } from "better-result";
import { Queue, Worker } from "bullmq";

import { publishShareItem } from "@/api/handlers/share-spaces/share-publisher";
import { captureError } from "@/api/lib/analytics/capture";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { connectionErrorFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedOrganizationId,
  brandPersistedShareItemId,
  brandPersistedShareSpaceId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const QUEUE_NAME = "share-publications";
const JOB_NAME = "publish-share-item";
const WORKER_CONCURRENCY = 2;

type SharePublicationJobData = {
  organizationId: string;
  workspaceId: string;
  userId: string;
  shareSpaceId: string;
  shareItemId: string;
};

export type EnqueueSharePublicationOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  shareSpaceId: SafeId<"shareSpace">;
  shareItemId: SafeId<"shareItem">;
};

let queue: Queue<SharePublicationJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<SharePublicationJobData> => {
  queue ??= new Queue<SharePublicationJobData>(QUEUE_NAME, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return queue;
};

export const enqueueSharePublication = async (
  options: EnqueueSharePublicationOptions,
): Promise<void> => {
  await getQueue().add(JOB_NAME, options, {
    jobId: createBullMqJobId(options.workspaceId, options.shareItemId),
  });
};

const processSharePublicationJob = async (
  data: SharePublicationJobData,
): Promise<void> => {
  const organizationId = brandPersistedOrganizationId(data.organizationId);
  const workspaceId = brandPersistedWorkspaceId(data.workspaceId);
  const userId = brandPersistedUserId(data.userId);
  const scopedDb = createRootScopedDb({
    organizationId,
    workspaceIds: [workspaceId],
    userId,
  });
  const result = await publishShareItem({
    scopedDb,
    recordAuditEvent: createBackgroundAuditRecorder({
      organizationId,
      workspaceId,
      userId,
    }),
    organizationId,
    workspaceId,
    shareSpaceId: brandPersistedShareSpaceId(data.shareSpaceId),
    shareItemId: brandPersistedShareItemId(data.shareItemId),
  });
  if (Result.isError(result)) {
    throw result.error;
  }
};

export const initSharePublicationWorker = () => {
  const worker = new Worker<SharePublicationJobData>(
    QUEUE_NAME,
    async (job) => {
      await processSharePublicationJob(job.data);
    },
    {
      connection: createBullMqConnection(),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    captureError(error, {
      operation: "share_publication.failed",
      shareItemId: job?.data.shareItemId ?? "",
      shareSpaceId: job?.data.shareSpaceId ?? "",
    });
  });
  worker.on("error", (error) => {
    logger.error(
      "share_publication.worker_error",
      connectionErrorFields(error),
    );
  });

  logger.info("share_publication.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return worker;
};
