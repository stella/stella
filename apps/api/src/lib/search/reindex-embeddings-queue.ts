import type { Job } from "bullmq";
import { Queue, Worker } from "bullmq";

import { captureError } from "@/api/lib/analytics";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

import { generateEmbeddings } from "./embedding-generator";
import { storeEmbeddings, deleteEntityEmbeddings } from "./vector-store";

export type ReindexJobData = {
  entityId: string;
  text: string;
  workspaceId: string;
};

const QUEUE_NAME = "reindex-embeddings";
const WORKER_NAME = "reindex-embeddings-worker";

export const reindexQueue = new Queue<ReindexJobData>(QUEUE_NAME, {
  connection: createBullMqConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

const processReindexJob = async (job: Job<ReindexJobData>): Promise<void> => {
  const { entityId, text } = job.data;
  const safeEntityId = brandPersistedEntityId(entityId);

  await deleteEntityEmbeddings(safeEntityId);

  const embeddings = await generateEmbeddings(text, {
    preset: "balanced",
    chunking: {
      maxChars: 1000,
      maxOverlap: 100,
    },
  });

  if (embeddings.length === 0) {
    return;
  }

  await storeEmbeddings(
    embeddings.map((e) => ({
      entityId: safeEntityId,
      chunkIndex: e.chunkIndex,
      chunkText: e.text,
      embedding: e.embedding,
      metadata: {
        tokenCount: e.tokenCount,
      },
    })),
  );
};

export const reindexWorker = new Worker<ReindexJobData>(
  WORKER_NAME,
  processReindexJob,
  {
    connection: createBullMqConnection(),
    concurrency: 5,
    limiter: {
      max: 100,
      duration: 60_000,
    },
  },
);

reindexWorker.on("failed", (job, error) => {
  captureError(error, {
    source: "reindex-embeddings",
    jobId: job?.id ?? "unknown",
  });
});

reindexWorker.on("completed", () => {
  // no-op: completion handled by BullMQ dashboard
});

export const enqueueReindexJob = async (
  data: ReindexJobData,
): Promise<void> => {
  await reindexQueue.add("reindex", data, {
    jobId: `reindex-${data.entityId}-${Date.now()}`,
  });
};
