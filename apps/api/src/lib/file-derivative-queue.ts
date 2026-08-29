import { Result } from "better-result";
import { Worker } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import { fields } from "@/api/db/schema";
import { DERIVATIVE_FAILURE_REASON } from "@/api/db/schema-validators";
import type {
  DerivativeFailureReason,
  FieldContent,
} from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { decidePdfDerivativeAction } from "@/api/lib/file-derivative-decision";
import {
  allocateFileObject,
  resolveQueuedFileObject,
} from "@/api/lib/files/file-object-ids";
import {
  convertToPdf,
  shouldGeneratePdfDerivative,
} from "@/api/lib/files/gotenberg";
import {
  generateImageThumbnail,
  shouldGenerateImageThumbnail,
  THUMBNAIL_MIME_TYPE,
} from "@/api/lib/files/image-derivative";
import { createFileKey } from "@/api/lib/files/utils";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { getS3, readS3ArrayBuffer, writeS3ObjectWithRetry } from "@/api/lib/s3";
import {
  brandPersistedEntityId,
  brandPersistedFieldId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "file-derivatives";
const GENERATE_PDF_JOB_NAME = "generate-pdf";
const GENERATE_THUMBNAIL_JOB_NAME = "generate-thumbnail";
const WORKER_CONCURRENCY = 3;
const DEFAULT_JOB_ATTEMPTS = 3;

/** Which derivative a job produces; also the job id's discriminating part. */
export const FILE_DERIVATIVE_KIND = {
  PDF: "pdf",
  THUMBNAIL: "thumbnail",
} as const;

export type FileDerivativeKind =
  (typeof FILE_DERIVATIVE_KIND)[keyof typeof FILE_DERIVATIVE_KIND];

// PDF and thumbnail jobs carry the same identifiers; the job name on the
// BullMQ job distinguishes which derivative to produce.
type FileDerivativeJobData = {
  // Object id for the derivative this job produces, allocated by the producer
  // and replayed to every attempt, so the storage key a retry writes is the one
  // the previous attempt wrote. Absent only on jobs enqueued before the field
  // existed; see resolveQueuedFileObject.
  derivativeFileId?: string;
  entityId: string;
  fieldId: string;
  organizationId: string;
  userId: string;
  workspaceId: string;
};

type EnqueueFileDerivativeArgs = {
  encrypted: boolean;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  mimeType: string;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const getQueue = createLazyBullMqQueue<FileDerivativeJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const enqueuePdfDerivative = async ({
  encrypted,
  entityId,
  fieldId,
  mimeType,
  organizationId,
  userId,
  workspaceId,
}: EnqueueFileDerivativeArgs): Promise<void> => {
  if (!shouldGeneratePdfDerivative({ encrypted, mimeType })) {
    return;
  }

  await getQueue().add(
    GENERATE_PDF_JOB_NAME,
    {
      derivativeFileId: allocateFileObject(),
      entityId,
      fieldId,
      organizationId,
      userId,
      workspaceId,
    },
    {
      jobId: createBullMqJobId(workspaceId, fieldId, FILE_DERIVATIVE_KIND.PDF),
    },
  );
};

export const enqueuePdfDerivativeOrMarkFailed = async (
  args: EnqueueFileDerivativeArgs,
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
    await markPdfDerivativeFailed(
      args,
      DERIVATIVE_FAILURE_REASON.ENQUEUE,
    ).catch((markError: unknown) => {
      captureError(markError, {
        entityId: args.entityId,
        fieldId: args.fieldId,
        workspaceId: args.workspaceId,
      });
    });

    throw error;
  }
};

export const enqueueImageThumbnail = async ({
  encrypted,
  entityId,
  fieldId,
  mimeType,
  organizationId,
  userId,
  workspaceId,
}: EnqueueFileDerivativeArgs): Promise<void> => {
  if (!shouldGenerateImageThumbnail({ encrypted, mimeType })) {
    return;
  }

  await getQueue().add(
    GENERATE_THUMBNAIL_JOB_NAME,
    {
      derivativeFileId: allocateFileObject(),
      entityId,
      fieldId,
      organizationId,
      userId,
      workspaceId,
    },
    {
      jobId: createBullMqJobId(
        workspaceId,
        fieldId,
        FILE_DERIVATIVE_KIND.THUMBNAIL,
      ),
    },
  );
};

export const enqueueImageThumbnailOrMarkFailed = async (
  args: EnqueueFileDerivativeArgs,
): Promise<void> => {
  if (
    !shouldGenerateImageThumbnail({
      encrypted: args.encrypted,
      mimeType: args.mimeType,
    })
  ) {
    return;
  }

  try {
    await enqueueImageThumbnail(args);
  } catch (error) {
    await markImageThumbnailFailed(
      args,
      DERIVATIVE_FAILURE_REASON.ENQUEUE,
    ).catch((markError: unknown) => {
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
  // BullMQ workers use blocking commands and need a dedicated connection
  // separate from the queue's. Create a fresh raw client per worker init.
  const workerConnection = createBullMqConnection();

  const worker = new Worker<FileDerivativeJobData>(
    QUEUE_NAME,
    async (job) => {
      if (job.name === GENERATE_THUMBNAIL_JOB_NAME) {
        await processImageThumbnailJob(job.data);
        return;
      }
      await processPdfDerivativeJob(job.data);
    },
    {
      connection: workerConnection,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    const exhausted =
      job && job.attemptsMade >= (job.opts.attempts ?? DEFAULT_JOB_ATTEMPTS);
    if (exhausted && job.name === GENERATE_THUMBNAIL_JOB_NAME) {
      markImageThumbnailFailed(
        job.data,
        DERIVATIVE_FAILURE_REASON.PROCESSING,
      ).catch((markError: unknown) => {
        captureError(markError, {
          entityId: job.data.entityId,
          fieldId: job.data.fieldId,
          workspaceId: job.data.workspaceId,
        });
      });
    } else if (exhausted) {
      markPdfDerivativeFailed(
        job.data,
        DERIVATIVE_FAILURE_REASON.PROCESSING,
      ).catch((markError: unknown) => {
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
    logger.error("file_derivative.failed", {
      entityId: job?.data.entityId ?? "",
      "error.type": errorTag(error),
      fieldId: job?.data.fieldId ?? "",
      job: job?.name ?? "",
      workspaceId: job?.data.workspaceId ?? "",
    });
  });

  worker.on(
    "error",
    createQueueWorkerErrorLogger("file_derivative.worker_error"),
  );

  logger.info("file_derivative.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return worker;
};

const processPdfDerivativeJob = async ({
  derivativeFileId,
  entityId,
  fieldId,
  organizationId,
  userId,
  workspaceId,
}: FileDerivativeJobData): Promise<void> => {
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

  const action = decidePdfDerivativeAction(row?.content);
  if (action.type === "skip") {
    return;
  }

  if (action.type === "extract-only") {
    // The derivative is already `ready`; only search extraction/indexing is
    // outstanding (a retry after it threw). Re-run it so the document is not
    // permanently missing from search. If it keeps failing, BullMQ exhausts
    // the job and the `failed` handler captures the error; the derivative
    // stays `ready` because the PDF preview itself genuinely succeeded.
    // Broadcasts already fired on the ready flip, so they are not repeated.
    await processExtraction(brandedEntityId);
    return;
  }

  const content = action.content;
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

  const pdfFileId = resolveQueuedFileObject(derivativeFileId);
  const sourceFileId = content.id;
  const pdfKey = createFileKey({
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    fileId: pdfFileId,
    mimeType: PDF_MIME_TYPE,
  });

  // The key is fixed by the job's derivative id, so a retry after an attempt
  // died mid-write addresses the object that attempt left behind instead of
  // adding a second one. That is also the deterministic-key contract
  // writeS3ObjectWithRetry documents for its own attempts, which can time out
  // here and still land in the bucket.
  await writeS3ObjectWithRetry({
    data: new Uint8Array(conversionResult.value.buffer),
    key: pdfKey,
  });

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

  broadcastWorkspaceResourceUpdated(
    branded.workspaceId,
    resourceRef({ type: RESOURCE_TYPE.FIELD, id: brandedFieldId }),
  );

  await processExtraction(brandedEntityId);
};

const getS3File = async (key: string): Promise<ArrayBuffer> =>
  await readS3ArrayBuffer(key);

// The derivative-state literals below cast `::text::jsonb`, never a bare
// `::jsonb`. A bare cast fixes the bind parameter's type to jsonb, so the
// driver JSON-encodes the already-serialized string and `jsonb_set` stores a
// jsonb *string* instead of an object. `->>'status'` on that returns NULL, so
// the claim predicates read it back as 'pending' and requeue the field forever.
const readyPdfDerivativeContent = (pdfFileId: string) =>
  sql<FieldContent>`jsonb_set(
    jsonb_set(${fields.content}, '{pdfFileId}', to_jsonb(${pdfFileId}::text), true),
    '{pdfDerivative}',
    ${JSON.stringify({ status: "ready" })}::text::jsonb,
    true
  )`;

const failedPdfDerivativeContent = (reason: DerivativeFailureReason) =>
  sql<FieldContent>`jsonb_set(
    ${fields.content},
    '{pdfDerivative}',
    ${JSON.stringify({ status: "failed", reason })}::text::jsonb,
    true
  )`;

const markPdfDerivativeFailed = async (
  { fieldId, organizationId, userId, workspaceId }: FileDerivativeJobData,
  reason: DerivativeFailureReason,
): Promise<void> => {
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
        content: failedPdfDerivativeContent(reason),
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

const processImageThumbnailJob = async ({
  derivativeFileId,
  organizationId,
  fieldId,
  userId,
  workspaceId,
}: FileDerivativeJobData): Promise<void> => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId: brandPersistedUserId(userId),
    workspaceIds: [branded.workspaceId],
  });
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
    (row.content.thumbnailFileId ?? null) !== null ||
    !isPendingThumbnailDerivative(row.content)
  ) {
    return;
  }

  const content = row.content;
  if (
    !shouldGenerateImageThumbnail({
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
  const thumbnailResult = await generateImageThumbnail(
    new Uint8Array(sourceBuffer),
  );

  if (Result.isError(thumbnailResult)) {
    throw thumbnailResult.error;
  }

  const thumbnailFileId = resolveQueuedFileObject(derivativeFileId);
  const sourceFileId = content.id;
  const thumbnailKey = createFileKey({
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    fileId: thumbnailFileId,
    mimeType: THUMBNAIL_MIME_TYPE,
  });

  // Same fixed key across this job's attempts as the PDF path above.
  await writeS3ObjectWithRetry({
    data: thumbnailResult.value.webp,
    key: thumbnailKey,
  });

  try {
    const updatedRows = await scopedDb((tx) =>
      tx
        .update(fields)
        .set({
          content: readyThumbnailContent(
            thumbnailFileId,
            thumbnailResult.value.placeholder,
          ),
        })
        .where(
          and(
            eq(fields.id, brandedFieldId),
            eq(fields.workspaceId, branded.workspaceId),
            sql`${fields.content}->>'type' = 'file'`,
            sql`${fields.content}->>'id' = ${sourceFileId}`,
            sql`${fields.content}->>'thumbnailFileId' is null`,
            sql`coalesce(${fields.content}->'thumbnailDerivative'->>'status', 'pending') = 'pending'`,
          ),
        )
        .returning({ id: fields.id }),
    );

    if (updatedRows.length === 0) {
      await getS3().delete(thumbnailKey);
      return;
    }
  } catch (error) {
    await getS3()
      .delete(thumbnailKey)
      .catch((deleteError: unknown) => {
        captureError(deleteError, {
          fieldId: brandedFieldId,
          workspaceId: branded.workspaceId,
        });
      });
    throw error;
  }

  broadcastWorkspaceResourceUpdated(
    branded.workspaceId,
    resourceRef({ type: RESOURCE_TYPE.FIELD, id: brandedFieldId }),
  );
};

const isPendingThumbnailDerivative = (
  content: Extract<FieldContent, { type: "file" }>,
): boolean =>
  content.thumbnailDerivative?.status !== "not-required" &&
  content.thumbnailDerivative?.status !== "ready" &&
  content.thumbnailDerivative?.status !== "failed";

const readyThumbnailContent = (thumbnailFileId: string, placeholder: string) =>
  sql<FieldContent>`jsonb_set(
    jsonb_set(
      jsonb_set(${fields.content}, '{thumbnailFileId}', to_jsonb(${thumbnailFileId}::text), true),
      '{placeholder}',
      to_jsonb(${placeholder}::text),
      true
    ),
    '{thumbnailDerivative}',
    ${JSON.stringify({ status: "ready" })}::text::jsonb,
    true
  )`;

const failedThumbnailContent = (reason: DerivativeFailureReason) =>
  sql<FieldContent>`jsonb_set(
    ${fields.content},
    '{thumbnailDerivative}',
    ${JSON.stringify({ status: "failed", reason })}::text::jsonb,
    true
  )`;

const markImageThumbnailFailed = async (
  { fieldId, organizationId, userId, workspaceId }: FileDerivativeJobData,
  reason: DerivativeFailureReason,
): Promise<void> => {
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
        content: failedThumbnailContent(reason),
      })
      .where(
        and(
          eq(fields.id, brandPersistedFieldId(fieldId)),
          eq(fields.workspaceId, branded.workspaceId),
          sql`${fields.content}->>'type' = 'file'`,
          sql`${fields.content}->>'thumbnailFileId' is null`,
          sql`coalesce(${fields.content}->'thumbnailDerivative'->>'status', 'pending') = 'pending'`,
        ),
      ),
  );
};

// ── Reconciler-driven retry ─────────────────────────────
//
// A derivative whose job never reached the queue, or whose job was lost
// before it wrote a terminal state, has nothing left to drive it: the row
// stays `pending` (or `failed` with an `enqueue` reason) and the preview is
// gone for good. `requeueFileDerivative` is the recovery entry point the
// scheduled reconciler calls; a derivative that failed in *processing* is not
// reachable through it, because that failure is the worker's terminal verdict
// after it exhausted its attempts.

const pendingDerivativeState = JSON.stringify({ status: "pending" });

type DerivativeRequeueSpec = {
  /** Matches only a derivative a reconciler is allowed to retry. */
  claim: SQL | undefined;
  jobName: string;
  markFailed: (
    data: FileDerivativeJobData,
    reason: DerivativeFailureReason,
  ) => Promise<void>;
  pendingContent: SQL<FieldContent>;
};

const DERIVATIVE_REQUEUE = {
  [FILE_DERIVATIVE_KIND.PDF]: {
    claim: and(
      sql`${fields.content}->>'pdfFileId' is null`,
      sql`(
        coalesce(${fields.content}->'pdfDerivative'->>'status', 'pending') = 'pending'
        or (
          ${fields.content}->'pdfDerivative'->>'status' = 'failed'
          and ${fields.content}->'pdfDerivative'->>'reason' = ${DERIVATIVE_FAILURE_REASON.ENQUEUE}
        )
      )`,
    ),
    jobName: GENERATE_PDF_JOB_NAME,
    markFailed: markPdfDerivativeFailed,
    pendingContent: sql<FieldContent>`jsonb_set(
      ${fields.content},
      '{pdfDerivative}',
      ${pendingDerivativeState}::text::jsonb,
      true
    )`,
  },
  [FILE_DERIVATIVE_KIND.THUMBNAIL]: {
    claim: and(
      sql`${fields.content}->>'thumbnailFileId' is null`,
      sql`(
        coalesce(${fields.content}->'thumbnailDerivative'->>'status', 'pending') = 'pending'
        or (
          ${fields.content}->'thumbnailDerivative'->>'status' = 'failed'
          and ${fields.content}->'thumbnailDerivative'->>'reason' = ${DERIVATIVE_FAILURE_REASON.ENQUEUE}
        )
      )`,
    ),
    jobName: GENERATE_THUMBNAIL_JOB_NAME,
    markFailed: markImageThumbnailFailed,
    pendingContent: sql<FieldContent>`jsonb_set(
      ${fields.content},
      '{thumbnailDerivative}',
      ${pendingDerivativeState}::text::jsonb,
      true
    )`,
  },
} as const satisfies Record<FileDerivativeKind, DerivativeRequeueSpec>;

/**
 * What one retry did, so the reconciler can count outcomes rather than infer
 * them: `queue-owned` and `not-stuck` are both healthy, and neither is a
 * retry that has to be repeated.
 */
export const FILE_DERIVATIVE_REQUEUE_OUTCOME = {
  NOT_STUCK: "not-stuck",
  QUEUE_OWNED: "queue-owned",
  REQUEUED: "requeued",
} as const;

export type FileDerivativeRequeueOutcome =
  (typeof FILE_DERIVATIVE_REQUEUE_OUTCOME)[keyof typeof FILE_DERIVATIVE_REQUEUE_OUTCOME];

type RequeueFileDerivativeArgs = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  kind: FileDerivativeKind;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Retry one stuck derivative. The row is claimed first: the update only
 * matches a derivative that is still `pending` or failed on enqueue, so a
 * derivative that reached `ready`, `not-required`, or a processing failure
 * between the reconciler's read and this call is left exactly as it is.
 */
export const requeueFileDerivative = async ({
  entityId,
  fieldId,
  kind,
  organizationId,
  userId,
  workspaceId,
}: RequeueFileDerivativeArgs): Promise<FileDerivativeRequeueOutcome> => {
  const { claim, jobName, markFailed, pendingContent } =
    DERIVATIVE_REQUEUE[kind];
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId: brandPersistedUserId(userId),
    workspaceIds: [branded.workspaceId],
  });

  const claimed = await scopedDb((tx) =>
    tx
      .update(fields)
      .set({ content: pendingContent })
      .where(
        and(
          eq(fields.id, brandPersistedFieldId(fieldId)),
          eq(fields.workspaceId, branded.workspaceId),
          sql`${fields.content}->>'type' = 'file'`,
          claim,
        ),
      )
      .returning({ id: fields.id }),
  );

  if (claimed.length === 0) {
    return FILE_DERIVATIVE_REQUEUE_OUTCOME.NOT_STUCK;
  }

  // The job id is deterministic, and BullMQ ignores an `add` whose id is
  // already known: a retained completed/failed job would silently swallow
  // every retry. Reclaim that id, but keep the dead job's derivative object
  // id so the retry writes over what the previous attempt left in storage
  // instead of orphaning it.
  const jobId = createBullMqJobId(workspaceId, fieldId, kind);
  const derivativeQueue = getQueue();
  const priorJob = await derivativeQueue.getJob(jobId);
  let derivativeFileId = allocateFileObject();
  if (priorJob) {
    const state = await priorJob.getState();
    if (state !== "completed" && state !== "failed") {
      return FILE_DERIVATIVE_REQUEUE_OUTCOME.QUEUE_OWNED;
    }
    derivativeFileId = resolveQueuedFileObject(priorJob.data.derivativeFileId);
    await priorJob.remove();
  }

  const jobData = {
    derivativeFileId,
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  };

  try {
    await derivativeQueue.add(jobName, jobData, { jobId });
  } catch (error) {
    await markFailed(jobData, DERIVATIVE_FAILURE_REASON.ENQUEUE).catch(
      (markError: unknown) => {
        captureError(markError, { entityId, fieldId, workspaceId });
      },
    );
    throw error;
  }

  return FILE_DERIVATIVE_REQUEUE_OUTCOME.REQUEUED;
};
