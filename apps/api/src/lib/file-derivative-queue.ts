import { panic, Result } from "better-result";
import { DelayedError } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import type { ConversionRefusal } from "@stll/api-contract/conversion-refusal";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { fields, workspaces } from "@/api/db/schema";
import { DERIVATIVE_FAILURE_REASON } from "@/api/db/schema-validators";
import type {
  DerivativeFailureReason,
  FieldContent,
} from "@/api/db/schema-validators";
import { envBase } from "@/api/env-base";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUFFER_INTENT_DELETE_TIMEOUT_MS,
  BUFFER_INTENT_WRITE_TIMEOUT_MS,
  lockObjectCleanupIntentsForWriter,
  objectWriterSettlementAfterCleanup,
  reserveObjectCleanupIntent,
  retirePublishedObjectCleanupIntentsInTransaction,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  QUEUE_REQUEUE_OUTCOME,
  requeueDeterministicJob,
} from "@/api/lib/bullmq-requeue";
import type { QueueRequeueOutcome } from "@/api/lib/bullmq-requeue";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorTag } from "@/api/lib/errors/utils";
import { decidePdfDerivativeAction } from "@/api/lib/file-derivative-decision";
import type { FileKey } from "@/api/lib/file-key";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { deleteOrganizationFileWithSignal } from "@/api/lib/files/delete-organization-file";
import type { DerivativeRefusal } from "@/api/lib/files/derivative-admission";
import {
  admitDerivativeSourceBytes,
  DERIVATIVE_REFUSAL,
  DerivativeAdmissionError,
} from "@/api/lib/files/derivative-admission";
import {
  allocateFileObject,
  resolveQueuedFileObject,
} from "@/api/lib/files/file-object-ids";
import {
  ConversionInputError,
  type ConversionInputErrorReason,
  convertToPdf,
  shouldGeneratePdfDerivative,
} from "@/api/lib/files/gotenberg";
import {
  generateImageThumbnail,
  IMAGE_SOURCE_TOO_LARGE_CODE,
  shouldGenerateImageThumbnail,
  THUMBNAIL_MIME_TYPE,
} from "@/api/lib/files/image-derivative";
import {
  FILE_RESERVATION_ABANDON_DELAY_MS,
  OrganizationFileUsageError,
  writeOrganizationFile,
} from "@/api/lib/files/organization-file-usage";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import {
  createMemoryPressureGate,
  createPressurePause,
} from "@/api/lib/memory-pressure";
import type {
  MemoryPressureGate,
  PressurePause,
} from "@/api/lib/memory-pressure";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  derivativeDeferRssBytes,
  readProcessMemoryLimit,
} from "@/api/lib/observability/process-memory-limit";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  OBJECT_READ_TIMEOUT_MS,
  putS3ObjectWithSignal,
  readS3ObjectBounded,
  S3ObjectBudgetError,
} from "@/api/lib/s3";
import {
  brandNullablePersistedUserId,
  brandPersistedEntityId,
  brandPersistedFieldId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "file-derivatives";
const CONSUMPTION_TOGGLE_FAILED_SINK = failureSink({
  event: "file_derivative.consumption_toggle_failed",
  expected: [],
});
const GENERATE_PDF_JOB_NAME = "generate-pdf";
const GENERATE_THUMBNAIL_JOB_NAME = "generate-thumbnail";
/**
 * Derivative jobs one API process runs at once. Exported so the bound is
 * pinned by a test rather than by review.
 */
export const FILE_DERIVATIVE_WORKER_CONCURRENCY =
  LIMITS.fileDerivativeWorkerConcurrency;
/**
 * The one retry policy for a derivative: BullMQ's attempts, with exponential
 * backoff between them. The converter call itself never retries
 * (`retry: "caller"`), so one job is at most this many full conversions, and
 * memory is released between attempts.
 */
const DEFAULT_JOB_ATTEMPTS = 3;
const RESERVATION_RETRY_DELAY_MS = FILE_RESERVATION_ABANDON_DELAY_MS + 60_000;

export const deferFileDerivativeForPendingReservation = async ({
  error,
  job,
  now = Temporal.Now.instant().epochMilliseconds,
}: {
  error: unknown;
  job: {
    moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
    token?: string;
  };
  now?: number;
}): Promise<never> => {
  if (
    !(error instanceof OrganizationFileUsageError) ||
    error.reason !== "reservation_busy"
  ) {
    throw error;
  }

  // The same-key reservation cannot be reused until its object-state grace
  // expires. BullMQ's delayed transition leaves the attempt budget intact.
  await job.moveToDelayed(now + RESERVATION_RETRY_DELAY_MS, job.token);
  throw new DelayedError();
};

const lockActiveWorkspaceForDerivative = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<boolean> => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const workspaceRows = await tx
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
    .for("update");
  return workspaceRows.at(0)?.status === "active";
};

const cleanupUnpublishedDerivative = async ({
  intentId,
  objectKey,
  safeDb,
  telemetry,
  writeState,
}: {
  intentId: SafeId<"pendingUpload">;
  objectKey: string;
  safeDb: SafeDb;
  telemetry: Record<string, string>;
  writeState: "confirmed" | "uncertain";
}): Promise<void> => {
  const cleanup = Result.flatten(
    await Result.tryPromise({
      try: async () =>
        await withTimeout(
          async (signal) =>
            await deleteOrganizationFileWithSignal(objectKey, signal),
          {
            label: "file-derivative-compensating-delete",
            timeoutMs: BUFFER_INTENT_DELETE_TIMEOUT_MS,
          },
        ),
      catch: (cause) => cause,
    }),
  );
  if (Result.isError(cleanup)) {
    captureError(
      cleanup.error,
      handlerErrorContext(
        "lib.cleanupUnpublishedDerivative.cleanup_error",
        telemetry,
      ),
    );
  }
  const settlement = await settleObjectCleanupIntentsAfterWriter({
    intentIds: [intentId],
    objectState: objectWriterSettlementAfterCleanup({
      cleanupSucceeded: Result.isOk(cleanup),
      writeState,
    }),
    safeDb,
  });
  if (Result.isError(settlement)) {
    captureError(
      settlement.error,
      handlerErrorContext(
        "lib.cleanupUnpublishedDerivative.settlement_error",
        telemetry,
      ),
    );
  }
};

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
  userId: string | null;
  workspaceId: string;
};

type EnqueueFileDerivativeArgs = {
  encrypted: boolean;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  mimeType: string;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
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

const enqueuePdfDerivative = async ({
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
      captureError(
        markError,
        handlerErrorContext("lib.enqueuePdfDerivativeOrMarkFailed.markError", {
          entityId: args.entityId,
          fieldId: args.fieldId,
          workspaceId: args.workspaceId,
        }),
      );
    });

    throw error;
  }
};

const enqueueImageThumbnail = async ({
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
      captureError(
        markError,
        handlerErrorContext("lib.enqueueImageThumbnailOrMarkFailed.markError", {
          entityId: args.entityId,
          fieldId: args.fieldId,
          workspaceId: args.workspaceId,
        }),
      );
    });

    throw error;
  }
};

export const initFileDerivativeWorker = () => {
  // BullMQ workers use blocking commands and need a dedicated connection
  // separate from the queue's. Create a fresh raw client per worker init.
  const workerConnection = createBullMqConnection({
    storeClass: "durable-coordination",
  });

  // The limit is read once: it is fixed for the life of the process.
  const memoryLimit = readProcessMemoryLimit();
  const rssHighBytes = derivativeDeferRssBytes(memoryLimit);
  const memory = createMemoryPressureGate({
    holdMs: LIMITS.fileDerivativeMemoryPressureHoldMs,
    now: () => Temporal.Now.instant().epochMilliseconds,
    readRssBytes: () => process.memoryUsage.rss(),
    rssHighBytes,
  });
  process.on("memoryPressure", memory.record);

  // Bound late: the controller pauses the worker that runs the processor.
  let pauseTarget: { pause: () => void; resume: () => void } | null = null;
  const pausing = createPressurePause({
    gate: {
      read: () => memory.read(LIMITS.fileDerivativeSourceMaxBytes),
    },
    pause: () => pauseTarget?.pause(),
    resume: () => pauseTarget?.resume(),
    recheckMs: LIMITS.fileDerivativeDeferDelayMs,
    onClose: (reading) => {
      logger.warn("file_derivative.paused", {
        "memory.pressure_cause": reading.cause ?? "",
        "memory.rss_bytes": reading.rssBytes,
      });
    },
    onOpen: (reading) => {
      logger.info("file_derivative.resumed", {
        "memory.rss_bytes": reading.rssBytes,
      });
    },
  });

  const worker = new BullMqWorker<FileDerivativeJobData>(
    QUEUE_NAME,
    createFileDerivativeProcessor({
      memory,
      pausing,
      processPdf: processPdfDerivativeJob,
      processThumbnail: processImageThumbnailJob,
    }),
    {
      connection: workerConnection,
      concurrency: FILE_DERIVATIVE_WORKER_CONCURRENCY,
    },
  );

  pauseTarget = {
    // Local pause without waiting: it is called from inside the processor,
    // which must still finish the job in hand.
    pause: () => {
      worker.pause(true).catch((error: unknown) => {
        observeFailure(error, {
          sink: CONSUMPTION_TOGGLE_FAILED_SINK,
          ctx: { queue: QUEUE_NAME },
        });
      });
    },
    resume: () => {
      worker.resume().catch((error: unknown) => {
        observeFailure(error, {
          sink: CONSUMPTION_TOGGLE_FAILED_SINK,
          ctx: { queue: QUEUE_NAME },
        });
      });
    },
  };

  worker.on("failed", (job, error) => {
    const exhausted =
      job && job.attemptsMade >= (job.opts.attempts ?? DEFAULT_JOB_ATTEMPTS);
    if (exhausted && job.name === GENERATE_THUMBNAIL_JOB_NAME) {
      markImageThumbnailFailed(
        job.data,
        DERIVATIVE_FAILURE_REASON.PROCESSING,
      ).catch((markError: unknown) => {
        captureError(
          markError,
          handlerErrorContext("fileDerivative.markThumbnailFailed", {
            entityId: job.data.entityId,
            fieldId: job.data.fieldId,
            workspaceId: job.data.workspaceId,
          }),
        );
      });
    } else if (exhausted) {
      markPdfDerivativeFailed(
        job.data,
        DERIVATIVE_FAILURE_REASON.PROCESSING,
      ).catch((markError: unknown) => {
        captureError(
          markError,
          handlerErrorContext("fileDerivative.markPdfFailed", {
            entityId: job.data.entityId,
            fieldId: job.data.fieldId,
            workspaceId: job.data.workspaceId,
          }),
        );
      });
    }

    captureError(
      error,
      handlerErrorContext("lib.initFileDerivativeWorker", {
        entityId: job?.data.entityId ?? "",
        fieldId: job?.data.fieldId ?? "",
        workspaceId: job?.data.workspaceId ?? "",
      }),
    );
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
    concurrency: String(FILE_DERIVATIVE_WORKER_CONCURRENCY),
    "memory.defer_rss_bytes": rssHighBytes,
    "memory.limit_bytes":
      memoryLimit.type === "limited" ? memoryLimit.bytes : memoryLimit.type,
  });

  return {
    queues: [QUEUE_NAME] as const,
    close: async () => {
      process.off("memoryPressure", memory.record);
      pausing.stop();
      await worker.close();
    },
  };
};

type FileDerivativeProcessorJob = {
  data: FileDerivativeJobData;
  moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
  name: string;
  token?: string;
};

/**
 * The derivative worker's job handler. Before a job does any work it reads
 * the memory gate. Under pressure only the job in hand goes back to the
 * queue delayed (BullMQ does this without consuming an attempt), and the
 * worker stops taking jobs until the gate reopens, so a backlog is not
 * claimed and re-delayed job by job. Previews are postponed, never failed.
 */
export const createFileDerivativeProcessor =
  ({
    memory,
    now = () => Temporal.Now.instant().epochMilliseconds,
    pausing,
    processPdf,
    processThumbnail,
  }: {
    memory: Pick<MemoryPressureGate, "read">;
    now?: () => number;
    pausing: Pick<PressurePause, "closed">;
    processPdf: (data: FileDerivativeJobData) => Promise<void>;
    processThumbnail: (data: FileDerivativeJobData) => Promise<void>;
  }) =>
  async (job: FileDerivativeProcessorJob): Promise<void> => {
    // Reserve the full admitted input budget before claiming converter work.
    // Every backend enforces this same cap, so even legacy jobs without a
    // recorded source size receive conservative byte-weighted admission.
    const pressure = memory.read(LIMITS.fileDerivativeSourceMaxBytes);
    if (pressure.cause !== null) {
      pausing.closed(pressure);
      await job.moveToDelayed(
        now() + LIMITS.fileDerivativeDeferDelayMs,
        job.token,
      );
      throw new DelayedError();
    }
    try {
      if (job.name === GENERATE_THUMBNAIL_JOB_NAME) {
        await processThumbnail(job.data);
        return;
      }
      await processPdf(job.data);
    } catch (error) {
      await deferFileDerivativeForPendingReservation({ error, job });
    }
  };

/** The stored failure reason for a source admission refused. */
const FAILURE_REASON_FOR_REFUSAL = {
  [DERIVATIVE_REFUSAL.SOURCE_BYTES]: DERIVATIVE_FAILURE_REASON.TOO_LARGE,
  [DERIVATIVE_REFUSAL.SOURCE_PIXELS]: DERIVATIVE_FAILURE_REASON.TOO_LARGE,
  // An image whose header cannot be read would fail every attempt the same
  // way, so it is terminal at once rather than after the retry budget.
  [DERIVATIVE_REFUSAL.UNREADABLE_HEADER]: DERIVATIVE_FAILURE_REASON.PROCESSING,
} as const satisfies Record<DerivativeRefusal, DerivativeFailureReason>;

type DerivativeSource<T> =
  | { type: "admitted"; source: T }
  | { type: "refused"; reason: DerivativeFailureReason };

/**
 * Read a derivative's source only once it is admitted. The recorded size is
 * checked before anything is read; the read itself is bounded by the same
 * budget against the store's declared length, so a size the row understates
 * is still refused before the body is held.
 */
export const loadDerivativeSource = async <T>({
  read,
  sizeBytes,
}: {
  read: (maxBytes: number) => Promise<T>;
  sizeBytes: number;
}): Promise<DerivativeSource<T>> => {
  const refusal = admitDerivativeSourceBytes(sizeBytes);
  if (refusal !== null) {
    return {
      type: "refused",
      reason: FAILURE_REASON_FOR_REFUSAL[refusal.refusal],
    };
  }
  try {
    return {
      type: "admitted",
      source: await read(LIMITS.fileDerivativeSourceMaxBytes),
    };
  } catch (error) {
    if (error instanceof S3ObjectBudgetError) {
      return { type: "refused", reason: DERIVATIVE_FAILURE_REASON.TOO_LARGE };
    }
    throw error;
  }
};

const MARK_DERIVATIVE_FAILED = {
  [FILE_DERIVATIVE_KIND.PDF]: async (
    data: FileDerivativeJobData,
    reason: DerivativeFailureReason,
    conversionRefusal?: DisplayableConversionRefusal,
  ) => await markPdfDerivativeFailed(data, reason, conversionRefusal),
  [FILE_DERIVATIVE_KIND.THUMBNAIL]: async (
    data: FileDerivativeJobData,
    reason: DerivativeFailureReason,
  ) => await markImageThumbnailFailed(data, reason),
} as const satisfies Record<
  FileDerivativeKind,
  (
    data: FileDerivativeJobData,
    reason: DerivativeFailureReason,
    conversionRefusal?: DisplayableConversionRefusal,
  ) => Promise<void>
>;

/** Record a terminal refusal; the job then completes without a retry. */
const refuseDerivative = async ({
  fieldId,
  jobData,
  kind,
  reason,
  conversionRefusal,
  workspaceId,
}: {
  fieldId: SafeId<"field">;
  jobData: FileDerivativeJobData;
  kind: FileDerivativeKind;
  reason: DerivativeFailureReason;
  conversionRefusal?: DisplayableConversionRefusal;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  logger.info("file_derivative.refused", {
    fieldId,
    kind,
    reason,
    workspaceId,
  });
  await MARK_DERIVATIVE_FAILED[kind](jobData, reason, conversionRefusal);
};

type FileFieldContent = Extract<FieldContent, { type: "file" }>;

type DisplayableConversionRefusal = ConversionRefusal;

/** Every refusal the user can act on is shown; a new kind must choose. */
export const displayableConversionRefusal = (
  reason: ConversionInputErrorReason,
): DisplayableConversionRefusal | undefined => {
  switch (reason.kind) {
    case "unsupported_encoding": {
      return { kind: reason.kind, encoding: reason.encoding.slice(0, 256) };
    }
    case "unsupported_reference": {
      return {
        kind: reason.kind,
        format: reason.format.slice(0, 256),
        element: reason.element.slice(0, 512),
        attribute: reason.attribute.slice(0, 512),
      };
    }
    case "unsupported_field": {
      return { kind: reason.kind, fieldType: reason.fieldType.slice(0, 256) };
    }
    case "legacy_format": {
      return reason;
    }
    case "external_reference":
    case "inspection_failed": {
      return undefined;
    }
    default: {
      reason satisfies never;
      return panic("Unclassified conversion refusal");
    }
  }
};

type DerivativeBuild<T> =
  | { type: "built"; value: T }
  | {
      type: "refused";
      reason: DerivativeFailureReason;
      conversionRefusal?: DisplayableConversionRefusal;
    };

const readSourceWithinBudget = async <T>(
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> =>
  await withTimeout(read, {
    label: "file-derivative-source-read",
    timeoutMs: OBJECT_READ_TIMEOUT_MS,
  });

/**
 * Read an admitted source once and convert it to PDF. The converter makes a
 * single attempt (`retry: "caller"`): the job's attempts are the only retry.
 */
const buildPdfDerivative = async (
  content: FileFieldContent,
  sourceKey: FileKey,
): Promise<DerivativeBuild<ArrayBuffer>> => {
  const source = await loadDerivativeSource<ScannedFile>({
    sizeBytes: content.sizeBytes,
    read: async (maxBytes) =>
      await readSourceWithinBudget(
        async (signal) =>
          await readStoredFile({
            key: sourceKey,
            mimeType: content.mimeType,
            fileName: content.fileName,
            maxBytes,
            signal,
          }),
      ),
  });
  if (source.type === "refused") {
    return source;
  }
  const conversion = await convertToPdf(source.source, {
    retry: "caller",
  });
  if (Result.isError(conversion)) {
    if (conversion.error instanceof ConversionInputError) {
      const conversionRefusal = displayableConversionRefusal(
        conversion.error.reason,
      );
      return {
        type: "refused",
        reason: DERIVATIVE_FAILURE_REASON.PROCESSING,
        ...(conversionRefusal === undefined ? {} : { conversionRefusal }),
      };
    }
    if (conversion.error instanceof DerivativeAdmissionError) {
      return {
        type: "refused",
        reason: FAILURE_REASON_FOR_REFUSAL[conversion.error.refusal],
      };
    }
    throw conversion.error;
  }
  return { type: "built", value: conversion.value.buffer };
};

/** Read an admitted image once and render its thumbnail and placeholder. */
const buildThumbnailDerivative = async (
  content: FileFieldContent,
  sourceKey: FileKey,
): Promise<DerivativeBuild<{ placeholder: string; webp: Uint8Array }>> => {
  const source = await loadDerivativeSource<Uint8Array>({
    sizeBytes: content.sizeBytes,
    read: async (maxBytes) =>
      await readSourceWithinBudget(
        async (signal) =>
          await readS3ObjectBounded({
            bucket: envBase.S3_BUCKET,
            key: sourceKey,
            maxBytes,
            signal,
          }),
      ),
  });
  if (source.type === "refused") {
    return source;
  }
  const thumbnail = await generateImageThumbnail(source.source);
  if (Result.isError(thumbnail)) {
    if (thumbnail.error.code === IMAGE_SOURCE_TOO_LARGE_CODE) {
      return { type: "refused", reason: DERIVATIVE_FAILURE_REASON.TOO_LARGE };
    }
    throw thumbnail.error;
  }
  return { type: "built", value: thumbnail.value };
};

const processPdfDerivativeJob = async (
  jobData: FileDerivativeJobData,
): Promise<void> => {
  const {
    derivativeFileId,
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  } = jobData;
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId: brandNullablePersistedUserId(userId),
    workspaceIds: [branded.workspaceId],
  });
  const safeDb = createRootSafeDb({
    organizationId: branded.organizationId,
    userId: brandNullablePersistedUserId(userId),
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
  const built = await buildPdfDerivative(content, sourceKey);
  if (built.type === "refused") {
    await refuseDerivative({
      fieldId: brandedFieldId,
      jobData,
      kind: FILE_DERIVATIVE_KIND.PDF,
      reason: built.reason,
      ...(built.conversionRefusal === undefined
        ? {}
        : { conversionRefusal: built.conversionRefusal }),
      workspaceId: branded.workspaceId,
    });
    return;
  }

  const pdfFileId = resolveQueuedFileObject(derivativeFileId);
  const sourceFileId = content.id;
  const pdfKey = createFileKey({
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    fileId: pdfFileId,
    mimeType: PDF_MIME_TYPE,
  });
  const cleanupIntent = await reserveObjectCleanupIntent({
    objectKey: pdfKey,
    organizationId: branded.organizationId,
    safeDb,
    workspaceId: branded.workspaceId,
  });
  if (Result.isError(cleanupIntent)) {
    throw cleanupIntent.error;
  }

  let writeState: "confirmed" | "uncertain" = "uncertain";
  try {
    const pdfBytes = new Uint8Array(built.value);
    if (!isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
      await withTimeout(
        async (signal) =>
          await putS3ObjectWithSignal(pdfKey, pdfBytes, PDF_MIME_TYPE, signal),
        {
          label: "file-derivative-pdf-put",
          timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
        },
      );
    } else {
      const fileWrite = await writeOrganizationFile({
        organizationId: branded.organizationId,
        objectKey: pdfKey,
        sizeBytes: pdfBytes.byteLength,
        content: pdfBytes,
        write: async ({
          content: checkedContent,
          objectKey: checkedObjectKey,
        }) =>
          await withTimeout(
            async (signal) =>
              await putS3ObjectWithSignal(
                checkedObjectKey,
                checkedContent,
                PDF_MIME_TYPE,
                signal,
              ),
            {
              label: "file-derivative-pdf-put",
              timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
            },
          ),
      });
      if (Result.isError(fileWrite)) {
        throw fileWrite.error;
      }
    }
    writeState = "confirmed";
    const publication = await scopedDb(async (tx) => {
      if (!(await lockActiveWorkspaceForDerivative(tx, branded.workspaceId))) {
        return "workspace-inactive" as const;
      }
      await lockObjectCleanupIntentsForWriter(tx, [cleanupIntent.value]);
      // Publish the pointer only while the workspace and exact-key ownership
      // are still live. Lifecycle cleanup wins the same locks when it seals.
      const updatedRows = await tx
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
        .returning({ id: fields.id });
      if (updatedRows.length !== 1) {
        return "stale" as const;
      }
      await retirePublishedObjectCleanupIntentsInTransaction({
        intentIds: [cleanupIntent.value],
        tx,
      });
      return "published" as const;
    });

    if (publication !== "published") {
      await cleanupUnpublishedDerivative({
        intentId: cleanupIntent.value,
        objectKey: pdfKey,
        safeDb,
        telemetry: {
          fieldId: brandedFieldId,
          workspaceId: branded.workspaceId,
        },
        writeState,
      });
      return;
    }
  } catch (error) {
    await cleanupUnpublishedDerivative({
      intentId: cleanupIntent.value,
      objectKey: pdfKey,
      safeDb,
      telemetry: {
        fieldId: brandedFieldId,
        workspaceId: branded.workspaceId,
      },
      writeState,
    });
    throw error;
  }

  broadcastWorkspaceResourceUpdated(
    branded.workspaceId,
    resourceRef({ type: RESOURCE_TYPE.FIELD, id: brandedFieldId }),
  );

  await processExtraction(brandedEntityId);
};

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

const failedPdfDerivativeContent = (
  reason: DerivativeFailureReason,
  conversionRefusal?: DisplayableConversionRefusal,
) =>
  sql<FieldContent>`jsonb_set(
    ${fields.content},
    '{pdfDerivative}',
    ${JSON.stringify({
      status: "failed",
      reason,
      ...(conversionRefusal === undefined ? {} : { conversionRefusal }),
    })}::text::jsonb,
    true
  )`;

const markPdfDerivativeFailed = async (
  { fieldId, organizationId, userId, workspaceId }: FileDerivativeJobData,
  reason: DerivativeFailureReason,
  conversionRefusal?: DisplayableConversionRefusal,
): Promise<void> => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId: brandNullablePersistedUserId(userId),
    workspaceIds: [branded.workspaceId],
  });

  await scopedDb((tx) =>
    tx
      .update(fields)
      .set({
        content: failedPdfDerivativeContent(reason, conversionRefusal),
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

const processImageThumbnailJob = async (
  jobData: FileDerivativeJobData,
): Promise<void> => {
  const { derivativeFileId, organizationId, fieldId, userId, workspaceId } =
    jobData;
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createRootScopedDb({
    organizationId: branded.organizationId,
    userId: brandNullablePersistedUserId(userId),
    workspaceIds: [branded.workspaceId],
  });
  const safeDb = createRootSafeDb({
    organizationId: branded.organizationId,
    userId: brandNullablePersistedUserId(userId),
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
  const built = await buildThumbnailDerivative(content, sourceKey);
  if (built.type === "refused") {
    await refuseDerivative({
      fieldId: brandedFieldId,
      jobData,
      kind: FILE_DERIVATIVE_KIND.THUMBNAIL,
      reason: built.reason,
      workspaceId: branded.workspaceId,
    });
    return;
  }
  const thumbnail = built.value;

  const thumbnailFileId = resolveQueuedFileObject(derivativeFileId);
  const sourceFileId = content.id;
  const thumbnailKey = createFileKey({
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    fileId: thumbnailFileId,
    mimeType: THUMBNAIL_MIME_TYPE,
  });
  const cleanupIntent = await reserveObjectCleanupIntent({
    objectKey: thumbnailKey,
    organizationId: branded.organizationId,
    safeDb,
    workspaceId: branded.workspaceId,
  });
  if (Result.isError(cleanupIntent)) {
    throw cleanupIntent.error;
  }

  let writeState: "confirmed" | "uncertain" = "uncertain";
  try {
    if (!isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
      await withTimeout(
        async (signal) =>
          await putS3ObjectWithSignal(
            thumbnailKey,
            thumbnail.webp,
            THUMBNAIL_MIME_TYPE,
            signal,
          ),
        {
          label: "file-derivative-thumbnail-put",
          timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
        },
      );
    } else {
      const fileWrite = await writeOrganizationFile({
        organizationId: branded.organizationId,
        objectKey: thumbnailKey,
        sizeBytes: thumbnail.webp.byteLength,
        content: thumbnail.webp,
        write: async ({
          content: checkedContent,
          objectKey: checkedObjectKey,
        }) =>
          await withTimeout(
            async (signal) =>
              await putS3ObjectWithSignal(
                checkedObjectKey,
                checkedContent,
                THUMBNAIL_MIME_TYPE,
                signal,
              ),
            {
              label: "file-derivative-thumbnail-put",
              timeoutMs: BUFFER_INTENT_WRITE_TIMEOUT_MS,
            },
          ),
      });
      if (Result.isError(fileWrite)) {
        throw fileWrite.error;
      }
    }
    writeState = "confirmed";
    const publication = await scopedDb(async (tx) => {
      if (!(await lockActiveWorkspaceForDerivative(tx, branded.workspaceId))) {
        return "workspace-inactive" as const;
      }
      await lockObjectCleanupIntentsForWriter(tx, [cleanupIntent.value]);
      const updatedRows = await tx
        .update(fields)
        .set({
          content: readyThumbnailContent(
            thumbnailFileId,
            thumbnail.placeholder,
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
        .returning({ id: fields.id });
      if (updatedRows.length !== 1) {
        return "stale" as const;
      }
      await retirePublishedObjectCleanupIntentsInTransaction({
        intentIds: [cleanupIntent.value],
        tx,
      });
      return "published" as const;
    });

    if (publication !== "published") {
      await cleanupUnpublishedDerivative({
        intentId: cleanupIntent.value,
        objectKey: thumbnailKey,
        safeDb,
        telemetry: {
          fieldId: brandedFieldId,
          workspaceId: branded.workspaceId,
        },
        writeState,
      });
      return;
    }
  } catch (error) {
    await cleanupUnpublishedDerivative({
      intentId: cleanupIntent.value,
      objectKey: thumbnailKey,
      safeDb,
      telemetry: {
        fieldId: brandedFieldId,
        workspaceId: branded.workspaceId,
      },
      writeState,
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
    userId: brandNullablePersistedUserId(userId),
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

const REQUEUE_OUTCOME_FOR_QUEUE = {
  [QUEUE_REQUEUE_OUTCOME.QUEUE_OWNED]:
    FILE_DERIVATIVE_REQUEUE_OUTCOME.QUEUE_OWNED,
  [QUEUE_REQUEUE_OUTCOME.REQUEUED]: FILE_DERIVATIVE_REQUEUE_OUTCOME.REQUEUED,
} as const satisfies Record<QueueRequeueOutcome, FileDerivativeRequeueOutcome>;

type RequeueFileDerivativeArgs = {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  kind: FileDerivativeKind;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
  workspaceId: SafeId<"workspace">;
};

export type RequeueFileDerivativeDependencies = {
  allocateFileObject?: typeof allocateFileObject | undefined;
  createRootScopedDb?: typeof createRootScopedDb | undefined;
  getQueue?: typeof getQueue | undefined;
  markFailed?:
    | ((
        kind: FileDerivativeKind,
        data: FileDerivativeJobData,
        reason: DerivativeFailureReason,
      ) => Promise<void>)
    | undefined;
};

/**
 * Retry one stuck derivative. The row is claimed first: the update only
 * matches a derivative that is still `pending` or failed on enqueue, so a
 * derivative that reached `ready`, `not-required`, or a processing failure
 * between the reconciler's read and this call is left exactly as it is.
 */
export const requeueFileDerivative = async (
  {
    entityId,
    fieldId,
    kind,
    organizationId,
    userId,
    workspaceId,
  }: RequeueFileDerivativeArgs,
  {
    allocateFileObject: allocateDerivativeFile = allocateFileObject,
    createRootScopedDb: createScopedDb = createRootScopedDb,
    getQueue: getDerivativeQueue = getQueue,
    markFailed = async (targetKind, data, reason) =>
      await DERIVATIVE_REQUEUE[targetKind].markFailed(data, reason),
  }: RequeueFileDerivativeDependencies = {},
): Promise<FileDerivativeRequeueOutcome> => {
  const { claim, jobName, pendingContent } = DERIVATIVE_REQUEUE[kind];
  const branded = brandValidatedWorkflowActorKey({
    organizationId,
    workspaceId,
  });
  const scopedDb = createScopedDb({
    organizationId: branded.organizationId,
    userId,
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

  const jobData = {
    derivativeFileId: allocateDerivativeFile(),
    entityId,
    fieldId,
    organizationId,
    userId,
    workspaceId,
  };

  let outcome: QueueRequeueOutcome;
  try {
    outcome = await requeueDeterministicJob({
      data: jobData,
      jobId: createBullMqJobId(workspaceId, fieldId, kind),
      name: jobName,
      queue: getDerivativeQueue(),
      // A job the queue retains keeps its derivative object id, so the rerun
      // writes over what the previous attempt left in storage instead of
      // orphaning it.
      reclaimData: (previous) => ({
        ...jobData,
        derivativeFileId: resolveQueuedFileObject(
          previous.data.derivativeFileId,
        ),
      }),
    });
  } catch (error) {
    await markFailed(kind, jobData, DERIVATIVE_FAILURE_REASON.ENQUEUE).catch(
      (markError: unknown) => {
        captureError(
          markError,
          handlerErrorContext("lib.requeueFileDerivative.markError", {
            entityId,
            fieldId,
            workspaceId,
          }),
        );
      },
    );
    throw error;
  }

  return REQUEUE_OUTCOME_FOR_QUEUE[outcome];
};
