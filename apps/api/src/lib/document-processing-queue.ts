import { Result, TaggedError } from "better-result";
import { Queue, Worker } from "bullmq";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { encryptContent } from "@/api/lib/content-encryption";
import {
  DocumentOcrProviderError,
  recognizePdfText,
} from "@/api/lib/document-processing-provider";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import { getSearchProvider } from "@/api/lib/search/provider";
import { broadcast } from "@/api/lib/sse";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "document-processing";
const OCR_JOB_NAME = "ocr";
const OCR_SOURCE_URL_TTL_SECONDS = 35 * 60;
const WORKER_CONCURRENCY = 2;
const DEFAULT_JOB_ATTEMPTS = 3;
const RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_BATCH_SIZE = 100;
const ENQUEUE_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;
const ENQUEUE_FAILURE_RETRY_MS = 30_000;
const WORKER_LEASE_TIMEOUT_MS = 40 * 60 * 1000;

type DocumentProcessingJobData = {
  runId: SafeId<"documentProcessingRun">;
};

type CurrentOcrSource = {
  content: FieldContent;
  currentVersionId: SafeId<"entityVersion"> | null;
  entityReadOnly: boolean;
  fieldEntityVersionId: SafeId<"entityVersion">;
  versionDeletedAt: Date | null;
};

export class DocumentProcessingJobError extends TaggedError(
  "DocumentProcessingJobError",
)<{
  code: string;
  message: string;
  cause?: unknown;
}>() {}

let queue: Queue<DocumentProcessingJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<DocumentProcessingJobData> => {
  queue ??= new Queue<DocumentProcessingJobData>(QUEUE_NAME, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: DEFAULT_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return queue;
};

export const enqueueDocumentProcessingRun = async (
  runId: SafeId<"documentProcessingRun">,
): Promise<void> => {
  const jobId = createBullMqJobId("document-processing", runId);
  const existing = await getQueue().getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      await existing.retry();
      return;
    }
    if (state !== "completed") {
      return;
    }
    await existing.remove();
  }

  await getQueue().add(OCR_JOB_NAME, { runId }, { jobId });
};

export const requestAutomaticDocumentOcr = async ({
  entityId,
  entityVersionId,
  fieldId,
  organizationId,
  sourceFileId,
  sourceSha256Hex,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  sourceFileId: string;
  sourceSha256Hex: string;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  const run = await rootDb.transaction(async (tx) => {
    const settings = await tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { documentProcessingMode: true },
    });
    if (settings?.documentProcessingMode !== "searchable-text") {
      return null;
    }

    const currentRows = await tx
      .select({ content: fields.content })
      .from(entities)
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, entityVersionId),
          eq(entityVersions.entityId, entities.id),
          eq(entityVersions.workspaceId, workspaceId),
          isNull(entityVersions.deletedAt),
        ),
      )
      .innerJoin(
        fields,
        and(
          eq(fields.id, fieldId),
          eq(fields.entityVersionId, entityVersionId),
          eq(fields.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(entities.id, entityId),
          eq(entities.workspaceId, workspaceId),
          eq(entities.currentVersionId, entityVersionId),
          eq(entities.readOnly, false),
        ),
      )
      .limit(1)
      .for("update");
    const content = currentRows.at(0)?.content;
    if (
      content?.type !== "file" ||
      content.id !== sourceFileId ||
      content.sha256Hex !== sourceSha256Hex ||
      content.mimeType !== PDF_MIME_TYPE ||
      content.encrypted
    ) {
      return null;
    }

    const inserted = await tx
      .insert(documentProcessingRuns)
      .values({
        id: createSafeId<"documentProcessingRun">(),
        organizationId,
        workspaceId,
        entityId,
        entityVersionId,
        fieldId,
        sourceFileId,
        sourceSha256Hex,
        kind: "ocr",
        processorVersion: 1,
        requestSource: "upload",
        requestedBy: null,
      })
      .onConflictDoNothing({
        target: [
          documentProcessingRuns.organizationId,
          documentProcessingRuns.kind,
          documentProcessingRuns.entityVersionId,
          documentProcessingRuns.fieldId,
          documentProcessingRuns.sourceFileId,
          documentProcessingRuns.sourceSha256Hex,
          documentProcessingRuns.processorVersion,
        ],
      })
      .returning({ id: documentProcessingRuns.id });
    const created = inserted.at(0);
    if (created) {
      return created;
    }

    return await tx.query.documentProcessingRuns.findFirst({
      where: {
        organizationId: { eq: organizationId },
        workspaceId: { eq: workspaceId },
        entityId: { eq: entityId },
        entityVersionId: { eq: entityVersionId },
        fieldId: { eq: fieldId },
        sourceFileId: { eq: sourceFileId },
        sourceSha256Hex: { eq: sourceSha256Hex },
        kind: { eq: "ocr" },
        processorVersion: { eq: 1 },
        status: { eq: "queued" },
      },
      columns: { id: true },
    });
  });

  if (run) {
    await enqueueDocumentProcessingRun(run.id);
  }
};

export const isCurrentOcrSource = ({
  run,
  source,
}: {
  run: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
  };
  source: CurrentOcrSource | null;
}): boolean =>
  source !== null &&
  !source.entityReadOnly &&
  source.versionDeletedAt === null &&
  source.currentVersionId === run.entityVersionId &&
  source.fieldEntityVersionId === run.entityVersionId &&
  source.content.type === "file" &&
  source.content.id === run.sourceFileId &&
  source.content.sha256Hex === run.sourceSha256Hex &&
  source.content.mimeType === PDF_MIME_TYPE &&
  !source.content.encrypted;

const markRunCancelled = async (
  runId: SafeId<"documentProcessingRun">,
  cancellationCode: "policy_disabled" | "source_superseded",
): Promise<void> => {
  await rootDb
    .update(documentProcessingRuns)
    .set({
      errorAt: new Date(),
      errorCode: cancellationCode,
      finishedAt: new Date(),
      status: "cancelled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, runId),
        eq(documentProcessingRuns.status, "running"),
      ),
    );
};

const readCurrentOcrSource = async ({
  entityId,
  fieldId,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  workspaceId: SafeId<"workspace">;
}): Promise<CurrentOcrSource | null> => {
  const rows = await rootDb
    .select({
      content: fields.content,
      currentVersionId: entities.currentVersionId,
      entityReadOnly: entities.readOnly,
      fieldEntityVersionId: fields.entityVersionId,
      versionDeletedAt: entityVersions.deletedAt,
    })
    .from(entities)
    .innerJoin(
      fields,
      and(eq(fields.id, fieldId), eq(fields.workspaceId, workspaceId)),
    )
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, fields.entityVersionId),
        eq(entityVersions.entityId, entities.id),
        eq(entityVersions.workspaceId, workspaceId),
      ),
    )
    .where(
      and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
    )
    .limit(1);

  return rows.at(0) ?? null;
};

const persistOcrProjection = async ({
  ciphertext,
  iv,
  pageCount,
  run,
  textLength,
}: {
  ciphertext: Buffer;
  iv: Buffer;
  pageCount: number;
  run: typeof documentProcessingRuns.$inferSelect;
  textLength: number;
}): Promise<boolean> =>
  await rootDb.transaction(async (tx) => {
    const lockedRows = await tx
      .select({
        content: fields.content,
        currentVersionId: entities.currentVersionId,
        entityReadOnly: entities.readOnly,
        fieldEntityVersionId: fields.entityVersionId,
        versionDeletedAt: entityVersions.deletedAt,
      })
      .from(entities)
      .innerJoin(
        fields,
        and(
          eq(fields.id, run.fieldId),
          eq(fields.workspaceId, run.workspaceId),
        ),
      )
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, fields.entityVersionId),
          eq(entityVersions.entityId, entities.id),
          eq(entityVersions.workspaceId, run.workspaceId),
        ),
      )
      .where(
        and(
          eq(entities.id, run.entityId),
          eq(entities.workspaceId, run.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    const source = lockedRows.at(0) ?? null;
    if (!isCurrentOcrSource({ run, source })) {
      await tx
        .update(documentProcessingRuns)
        .set({
          errorAt: new Date(),
          errorCode: "source_superseded",
          finishedAt: new Date(),
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(eq(documentProcessingRuns.id, run.id));
      return false;
    }

    await tx
      .insert(extractedContent)
      .values({
        workspaceId: run.workspaceId,
        entityId: run.entityId,
        organizationId: run.organizationId,
        ciphertext,
        iv,
        charCount: textLength,
        language: null,
        extractedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: extractedContent.entityId,
        set: {
          ciphertext,
          iv,
          charCount: textLength,
          language: null,
          extractedAt: new Date(),
        },
      });

    await tx
      .update(documentProcessingRuns)
      .set({
        progressCompleted: pageCount,
        progressTotal: pageCount,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingRuns.id, run.id),
          eq(documentProcessingRuns.status, "running"),
        ),
      );
    return true;
  });

export const processDocumentProcessingRun = async (
  runId: SafeId<"documentProcessingRun">,
): Promise<void> => {
  const claimedRows = await rootDb
    .update(documentProcessingRuns)
    .set({
      attemptCount: sql`${documentProcessingRuns.attemptCount} + 1`,
      claimedAt: new Date(),
      claimedBy: Bun.randomUUIDv7(),
      errorAt: null,
      errorCode: null,
      finishedAt: null,
      nextAttemptAt: null,
      progressCompleted: 0,
      progressTotal: null,
      startedAt: new Date(),
      status: "running",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, runId),
        inArray(documentProcessingRuns.status, ["queued", "failed"]),
      ),
    )
    .returning();
  const run = claimedRows.at(0);
  if (!run) {
    return;
  }

  if (run.requestSource === "upload") {
    const settings = await rootDb.query.organizationSettings.findFirst({
      where: { organizationId: { eq: run.organizationId } },
      columns: { documentProcessingMode: true },
    });
    if (settings?.documentProcessingMode !== "searchable-text") {
      await markRunCancelled(run.id, "policy_disabled");
      return;
    }
  }

  const source = await readCurrentOcrSource({
    entityId: run.entityId,
    fieldId: run.fieldId,
    workspaceId: run.workspaceId,
  });
  if (!isCurrentOcrSource({ run, source })) {
    await markRunCancelled(run.id, "source_superseded");
    return;
  }

  const sourceKey = createFileKey({
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    fileId: run.sourceFileId,
    mimeType: PDF_MIME_TYPE,
  });
  const sourceUrl = await presignDownloadUrl(sourceKey, {
    expiresIn: OCR_SOURCE_URL_TTL_SECONDS,
    scope: {
      organizationId: run.organizationId,
      workspaceId: run.workspaceId,
    },
  });
  const result = await recognizePdfText({
    idempotencyKey: `ocr:${run.id}`,
    sourceUrl,
  });
  if (Result.isError(result)) {
    throw new DocumentProcessingJobError({
      code: result.error.code,
      message: result.error.message,
      cause: result.error,
    });
  }

  const encrypted = await encryptContent(run.organizationId, result.value.text);
  const persisted = await persistOcrProjection({
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    pageCount: result.value.pageCount,
    run,
    textLength: result.value.text.length,
  });
  if (!persisted) {
    return;
  }

  await getSearchProvider().indexEntity(run.entityId);
  await rootDb
    .update(documentProcessingRuns)
    .set({
      errorAt: null,
      errorCode: null,
      finishedAt: new Date(),
      status: "succeeded",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, run.id),
        eq(documentProcessingRuns.status, "running"),
      ),
    );

  broadcast(run.workspaceId, {
    type: "invalidate-query",
    data: ["entities", run.workspaceId],
  });
};

const errorCode = (error: unknown): string => {
  if (
    error instanceof DocumentProcessingJobError ||
    error instanceof DocumentOcrProviderError
  ) {
    return error.code;
  }
  return "processing_failed";
};

const markRunFailed = async (
  runId: SafeId<"documentProcessingRun">,
  error: unknown,
): Promise<void> => {
  await rootDb
    .update(documentProcessingRuns)
    .set({
      errorAt: new Date(),
      errorCode: errorCode(error),
      status: "failed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, runId),
        eq(documentProcessingRuns.status, "running"),
      ),
    );
};

const enqueueQueuedRuns = async (): Promise<number> => {
  const now = new Date();
  const runs = await rootDb
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.status, "queued"),
        or(
          isNull(documentProcessingRuns.nextAttemptAt),
          lte(documentProcessingRuns.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.createdAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);

  for (const run of runs) {
    // oxlint-disable-next-line no-await-in-loop -- bounded reconciliation keeps enqueue pressure predictable and records each row's visibility lease
    const enqueueResult = await Result.tryPromise({
      try: async () => {
        await enqueueDocumentProcessingRun(run.id);
        await rootDb
          .update(documentProcessingRuns)
          .set({
            nextAttemptAt: new Date(Date.now() + ENQUEUE_VISIBILITY_TIMEOUT_MS),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documentProcessingRuns.id, run.id),
              eq(documentProcessingRuns.status, "queued"),
            ),
          );
      },
      catch: (cause) => cause,
    });
    if (Result.isOk(enqueueResult)) {
      continue;
    }

    captureError(enqueueResult.error, { runId: run.id });
    // oxlint-disable-next-line no-await-in-loop -- each failed row gets its own short retry lease so it cannot starve later queued work
    await rootDb
      .update(documentProcessingRuns)
      .set({
        nextAttemptAt: new Date(Date.now() + ENQUEUE_FAILURE_RETRY_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingRuns.id, run.id),
          eq(documentProcessingRuns.status, "queued"),
        ),
      );
  }
  return runs.length;
};

const recoverStaleDocumentProcessingRuns = async (): Promise<number> => {
  const staleBefore = new Date(Date.now() - WORKER_LEASE_TIMEOUT_MS);
  const staleRuns = await rootDb
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.status, "running"),
        lt(documentProcessingRuns.claimedAt, staleBefore),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.claimedAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);
  if (staleRuns.length === 0) {
    return 0;
  }

  const ids = staleRuns.map(({ id }) => id);
  const recovered = await rootDb
    .update(documentProcessingRuns)
    .set({
      claimedAt: null,
      claimedBy: null,
      errorAt: new Date(),
      errorCode: "worker_lease_expired",
      nextAttemptAt: null,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(documentProcessingRuns.id, ids),
        eq(documentProcessingRuns.status, "running"),
        lt(documentProcessingRuns.claimedAt, staleBefore),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return recovered.length;
};

export const initDocumentProcessingWorker = () => {
  const worker = new Worker<DocumentProcessingJobData>(
    QUEUE_NAME,
    async (job) => {
      await processDocumentProcessingRun(job.data.runId);
    },
    {
      connection: createBullMqConnection(),
      concurrency: WORKER_CONCURRENCY,
      lockDuration: 35 * 60 * 1000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on("failed", (job, error) => {
    if (job) {
      markRunFailed(job.data.runId, error).catch((markError: unknown) => {
        captureError(markError, { runId: job.data.runId });
      });
    }
    captureError(error, { runId: job?.data.runId ?? "" });
    logger.error("document_processing.failed", {
      "error.type": errorTag(error),
      runId: job?.data.runId ?? "",
    });
  });
  worker.on("error", (error) => {
    logger.error(
      "document_processing.worker_error",
      connectionErrorFields(error),
    );
  });

  let reconciling = false;
  const reconcile = () => {
    if (reconciling) {
      return;
    }
    reconciling = true;
    (async () => {
      const recoveredCount = await recoverStaleDocumentProcessingRuns();
      const enqueuedCount = await enqueueQueuedRuns();
      return { enqueuedCount, recoveredCount };
    })()
      .then(({ enqueuedCount, recoveredCount }) => {
        if (recoveredCount > 0 || enqueuedCount > 0) {
          logger.info("document_processing.reconciled", {
            enqueuedCount: String(enqueuedCount),
            recoveredCount: String(recoveredCount),
          });
        }
      })
      .catch((error: unknown) => {
        captureError(error);
        logger.error("document_processing.reconcile_failed", {
          "error.type": errorTag(error),
        });
      })
      .finally(() => {
        reconciling = false;
      });
  };
  reconcile();
  const reconcileInterval = setInterval(reconcile, RECONCILE_INTERVAL_MS);
  reconcileInterval.unref();

  logger.info("document_processing.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    close: async (): Promise<void> => {
      clearInterval(reconcileInterval);
      await worker.close();
    },
  };
};
