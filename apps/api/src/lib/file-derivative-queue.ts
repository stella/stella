import { Result } from "better-result";
import { Queue, Worker } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import Redis from "ioredis";

import { fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { env } from "@/api/env";
import {
  convertToPdf,
  shouldGeneratePdfDerivative,
} from "@/api/handlers/files/gotenberg";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { redisConnectionOptions } from "@/api/lib/redis-options";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3 } from "@/api/lib/s3";
import {
  brandPersistedEntityId,
  brandPersistedFieldId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { broadcast } from "@/api/lib/sse";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "file-derivatives";
const GENERATE_PDF_JOB_NAME = "generate-pdf";
const WORKER_CONCURRENCY = 3;
const DEFAULT_JOB_ATTEMPTS = 3;

type PdfDerivativeJobData = {
  entityId: string;
  fieldId: string;
  organizationId: string;
  userId: string;
  workspaceId: string;
};

type EnqueuePdfDerivativeArgs = {
  encrypted: boolean;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  mimeType: string;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

let queue: Queue<PdfDerivativeJobData> | null = null;
let redisClient: Redis | null = null;

const getRedis = (): Redis => {
  redisClient ??= new Redis(env.REDIS_URL, {
    ...redisConnectionOptions(),
    maxRetriesPerRequest: null,
  });
  return redisClient;
};

const getQueue = (): Queue<PdfDerivativeJobData> => {
  queue ??= new Queue<PdfDerivativeJobData>(QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: DEFAULT_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return queue;
};

export const enqueuePdfDerivative = async ({
  encrypted,
  entityId,
  fieldId,
  mimeType,
  organizationId,
  userId,
  workspaceId,
}: EnqueuePdfDerivativeArgs): Promise<void> => {
  if (!shouldGeneratePdfDerivative({ encrypted, mimeType })) {
    return;
  }

  await getQueue().add(
    GENERATE_PDF_JOB_NAME,
    {
      entityId,
      fieldId,
      organizationId,
      userId,
      workspaceId,
    },
    {
      jobId: `${workspaceId}:${fieldId}:pdf`,
    },
  );
};

export const enqueuePdfDerivativeOrMarkFailed = async (
  args: EnqueuePdfDerivativeArgs,
): Promise<void> => {
  if (
    !shouldGeneratePdfDerivative({
      encrypted: args.encrypted,
      mimeType: args.mimeType,
    })
  ) {
    return;
  }

  try {
    await enqueuePdfDerivative(args);
  } catch (error) {
    await markPdfDerivativeFailed(args).catch((markError: unknown) => {
      captureError(markError, {
        entityId: args.entityId,
        fieldId: args.fieldId,
        workspaceId: args.workspaceId,
      });
    });

    throw error;
  }
};

export const initFileDerivativeWorker = () => {
  const workerConnection = new Redis(env.REDIS_URL, {
    ...redisConnectionOptions(),
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<PdfDerivativeJobData>(
    QUEUE_NAME,
    async (job) => {
      await processPdfDerivativeJob(job.data);
    },
    {
      connection: workerConnection,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    if (
      job &&
      job.attemptsMade >= (job.opts.attempts ?? DEFAULT_JOB_ATTEMPTS)
    ) {
      markPdfDerivativeFailed(job.data).catch((markError: unknown) => {
        captureError(markError, {
          entityId: job.data.entityId,
          fieldId: job.data.fieldId,
          workspaceId: job.data.workspaceId,
        });
      });
    }

    captureError(error, {
      entityId: job?.data.entityId ?? "",
      fieldId: job?.data.fieldId ?? "",
      workspaceId: job?.data.workspaceId ?? "",
    });
    logger.error("file_derivative.pdf_failed", {
      entityId: job?.data.entityId ?? "",
      "error.type": errorTag(error),
      fieldId: job?.data.fieldId ?? "",
      workspaceId: job?.data.workspaceId ?? "",
    });
  });

  worker.on("error", (error) => {
    logger.error("file_derivative.worker_error", {
      "error.type": errorTag(error),
    });
  });

  logger.info("file_derivative.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return worker;
};

const processPdfDerivativeJob = async ({
  entityId,
  fieldId,
  organizationId,
  userId,
  workspaceId,
}: PdfDerivativeJobData): Promise<void> => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId: brandPersistedUserId(userId),
    workspaceIds: [branded.workspaceId],
  });
  const brandedEntityId = brandPersistedEntityId(entityId);
  const brandedFieldId = brandPersistedFieldId(fieldId);

  const row = await scopedDb((tx) =>
    tx.query.fields.findFirst({
      columns: { content: true },
      where: {
        id: { eq: brandedFieldId },
        workspaceId: { eq: branded.workspaceId },
      },
    }),
  );

  if (
    !row ||
    row.content.type !== "file" ||
    row.content.pdfFileId !== null ||
    !isPendingPdfDerivative(row.content)
  ) {
    return;
  }

  const content = row.content;
  if (
    !shouldGeneratePdfDerivative({
      encrypted: content.encrypted,
      mimeType: content.mimeType,
    })
  ) {
    return;
  }

  const sourceKey = createFileKey({
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  const sourceBuffer = await getS3File(sourceKey);
  const conversionResult = await convertToPdf(
    sourceBuffer,
    content.fileName,
    content.mimeType,
  );

  if (Result.isError(conversionResult)) {
    throw conversionResult.error;
  }

  const pdfFileId = Bun.randomUUIDv7();
  const sourceFileId = content.id;
  const pdfKey = createFileKey({
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    fileId: pdfFileId,
    mimeType: PDF_MIME_TYPE,
  });

  await getS3().write(pdfKey, new Uint8Array(conversionResult.value.buffer));

  try {
    const updatedRows = await scopedDb((tx) =>
      tx
        .update(fields)
        .set({
          content: readyPdfDerivativeContent(pdfFileId),
        })
        .where(
          and(
            eq(fields.id, brandedFieldId),
            eq(fields.workspaceId, branded.workspaceId),
            sql`${fields.content}->>'type' = 'file'`,
            sql`${fields.content}->>'id' = ${sourceFileId}`,
            sql`${fields.content}->>'pdfFileId' is null`,
            sql`coalesce(${fields.content}->'pdfDerivative'->>'status', 'pending') = 'pending'`,
          ),
        )
        .returning({ id: fields.id }),
    );

    if (updatedRows.length === 0) {
      await getS3().delete(pdfKey);
      return;
    }
  } catch (error) {
    await getS3()
      .delete(pdfKey)
      .catch((deleteError: unknown) => {
        captureError(deleteError, {
          fieldId: brandedFieldId,
          workspaceId: branded.workspaceId,
        });
      });
    throw error;
  }

  broadcast(branded.workspaceId, {
    type: "invalidate-query",
    data: ["entities", branded.workspaceId],
  });
  broadcast(branded.workspaceId, {
    type: "invalidate-query",
    data: ["files", branded.workspaceId, brandedFieldId],
  });
  broadcast(branded.workspaceId, {
    type: "invalidate-query",
    data: ["files", "metadata", branded.workspaceId, brandedFieldId],
  });

  await processExtraction(brandedEntityId);
};

const getS3File = async (key: string): Promise<ArrayBuffer> =>
  await getS3().file(key).arrayBuffer();

const isPendingPdfDerivative = (
  content: Extract<FieldContent, { type: "file" }>,
): boolean =>
  content.pdfDerivative?.status !== "not-required" &&
  content.pdfDerivative?.status !== "ready" &&
  content.pdfDerivative?.status !== "failed";

const readyPdfDerivativeContent = (pdfFileId: string) =>
  sql<FieldContent>`jsonb_set(
    jsonb_set(${fields.content}, '{pdfFileId}', to_jsonb(${pdfFileId}::text), true),
    '{pdfDerivative}',
    ${JSON.stringify({ status: "ready" })}::jsonb,
    true
  )`;

const failedPdfDerivativeContent = () =>
  sql<FieldContent>`jsonb_set(
    ${fields.content},
    '{pdfDerivative}',
    ${JSON.stringify({ status: "failed" })}::jsonb,
    true
  )`;

const markPdfDerivativeFailed = async ({
  fieldId,
  organizationId,
  userId,
  workspaceId,
}: PdfDerivativeJobData): Promise<void> => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId: brandPersistedUserId(userId),
    workspaceIds: [branded.workspaceId],
  });

  await scopedDb((tx) =>
    tx
      .update(fields)
      .set({
        content: failedPdfDerivativeContent(),
      })
      .where(
        and(
          eq(fields.id, brandPersistedFieldId(fieldId)),
          eq(fields.workspaceId, branded.workspaceId),
          sql`${fields.content}->>'type' = 'file'`,
          sql`${fields.content}->>'pdfFileId' is null`,
          sql`coalesce(${fields.content}->'pdfDerivative'->>'status', 'pending') = 'pending'`,
        ),
      ),
  );
};
