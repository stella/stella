import { Result, panic } from "better-result";
import { type Queue, Worker } from "bullmq";
import { and, asc, eq, isNull, lt } from "drizzle-orm";

import {
  PDF_DOCUMENT_MAX_BYTES,
  PDF_RASTER_MAX_OUTPUT_BYTES,
} from "@stll/anonymize-pdf";

import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { entities, pdfAnonymizationRuns } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { captureError } from "@/api/lib/analytics/capture";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { errorTag } from "@/api/lib/errors/utils";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { createFileKey } from "@/api/lib/files/utils";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import {
  PDF_ANONYMIZATION_ERROR_CODE,
  PDF_ANONYMIZATION_WORKER_TIMEOUT_MS,
  type PdfAnonymizationErrorCode,
} from "@/api/lib/pdf-anonymization/contract";
import {
  PdfAnonymizationProcessError,
  processPdfAnonymization,
} from "@/api/lib/pdf-anonymization/process";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { readS3ObjectBounded } from "@/api/lib/s3";
import {
  brandPersistedPdfAnonymizationRunId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "pdf-anonymization-runs";
const JOB_NAME = "run-pdf-anonymization";
const WORKER_CONCURRENCY = 1;
const JOB_ATTEMPTS = 1;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_RUNNING_MS = 60 * 60 * 1000;
const RECONCILE_BATCH_MAX = 100;
const SOURCE_READ_TIMEOUT_MS = 2 * 60 * 1000;

type PdfAnonymizationRunJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

type PdfAnonymizationRunQueue = Pick<
  Queue<PdfAnonymizationRunJobData>,
  "add" | "getJob"
>;

export type EnqueuePdfAnonymizationRunArgs = {
  runId: SafeId<"pdfAnonymizationRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<PdfAnonymizationRunJobData>({
  name: QUEUE_NAME,
  connectionOptions: {
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  },
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

const runJob = ({
  runId,
  workspaceId,
  organizationId,
  userId,
}: EnqueuePdfAnonymizationRunArgs) => ({
  name: JOB_NAME,
  data: { runId, workspaceId, organizationId, userId },
  opts: { jobId: createBullMqJobId(workspaceId, runId) },
});

export const enqueuePdfAnonymizationRun = async (
  args: EnqueuePdfAnonymizationRunArgs,
): Promise<void> => {
  const queue: PdfAnonymizationRunQueue = getQueue();
  const { name, data, opts } = runJob(args);
  const existing = await withTimeout(
    async () => await queue.getJob(opts.jobId),
    {
      label: "pdf-anonymization.queue.get-job",
      timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
    },
  );
  if (existing) {
    const state = await withTimeout(async () => await existing.getState(), {
      label: "pdf-anonymization.queue.get-state",
      timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
    });
    if (state === "failed") {
      await withTimeout(async () => await existing.retry(), {
        label: "pdf-anonymization.queue.retry-job",
        timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
      });
      return;
    }
    if (state !== "completed") {
      return;
    }
    await withTimeout(async () => await existing.remove(), {
      label: "pdf-anonymization.queue.remove-job",
      timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
    });
  }
  await withTimeout(async () => await queue.add(name, data, opts), {
    label: "pdf-anonymization.queue.add-job",
    timeoutMs: QUEUE_OPERATION_TIMEOUT_MS,
  });
};

type RunActor = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  runId: SafeId<"pdfAnonymizationRun">;
};

const brandActor = (data: PdfAnonymizationRunJobData): RunActor => {
  const scope = brandValidatedWorkflowActorKey({
    organizationId: data.organizationId,
    workspaceId: data.workspaceId,
  });
  const userId = brandPersistedUserId(data.userId);
  return {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    userId,
    runId: brandPersistedPdfAnonymizationRunId(data.runId),
    scopedDb: createRootScopedDb({
      organizationId: scope.organizationId,
      userId,
      workspaceIds: [scope.workspaceId],
    }),
  };
};

type ClaimedRun = {
  entityId: SafeId<"entity">;
  sourceFileId: SafeId<"userFile">;
  sourceFileName: string;
  sourceMimeType: string;
  sourceSha256Hex: string;
};

const claimRun = async (actor: RunActor): Promise<ClaimedRun | null> => {
  const claimed = await actor.scopedDb(async (tx) => {
    // audit: skip; lifecycle bookkeeping belongs to the audited run request.
    const rows = await tx
      .update(pdfAnonymizationRuns)
      .set({ status: "running", startedAt: new Date(), errorCode: null })
      .where(
        and(
          eq(pdfAnonymizationRuns.id, actor.runId),
          eq(pdfAnonymizationRuns.workspaceId, actor.workspaceId),
          eq(pdfAnonymizationRuns.status, "queued"),
        ),
      )
      .returning({
        entityId: pdfAnonymizationRuns.entityId,
        sourceFileId: pdfAnonymizationRuns.sourceFileId,
        sourceFileName: pdfAnonymizationRuns.sourceFileName,
        sourceMimeType: pdfAnonymizationRuns.sourceMimeType,
        sourceSha256Hex: pdfAnonymizationRuns.sourceSha256Hex,
      });
    return rows.at(0) ?? null;
  });
  return claimed;
};

const outputFileName = (sourceFileName: string): string => {
  const withoutExtension = sourceFileName.toLocaleLowerCase().endsWith(".pdf")
    ? sourceFileName.slice(0, -4)
    : sourceFileName;
  return `${withoutExtension} - anonymized.pdf`;
};

const setRunFailed = async (
  actor: RunActor,
  errorCode: PdfAnonymizationErrorCode,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip; this is terminal bookkeeping for the audited execution.
    await tx
      .update(pdfAnonymizationRuns)
      .set({ status: "failed", errorCode, finishedAt: new Date() })
      .where(
        and(
          eq(pdfAnonymizationRuns.id, actor.runId),
          eq(pdfAnonymizationRuns.workspaceId, actor.workspaceId),
          eq(pdfAnonymizationRuns.status, "running"),
        ),
      );
  });
};

const executeRun = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<PdfAnonymizationErrorCode | null> => {
  if (run.sourceMimeType !== PDF_MIME_TYPE) {
    return PDF_ANONYMIZATION_ERROR_CODE.invalidPdf;
  }
  const sourceKey = createFileKey({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    fileId: run.sourceFileId,
    mimeType: run.sourceMimeType,
  });
  const source = await withTimeout(
    async (signal) =>
      await readS3ObjectBounded({
        bucket: envBase.S3_BUCKET,
        key: sourceKey,
        maxBytes: PDF_DOCUMENT_MAX_BYTES,
        signal,
      }),
    {
      label: "pdf-anonymization.source.read",
      timeoutMs: SOURCE_READ_TIMEOUT_MS,
    },
  );
  const sourceSha256Hex = new Bun.CryptoHasher("sha256")
    .update(source)
    .digest("hex");
  if (sourceSha256Hex !== run.sourceSha256Hex) {
    return PDF_ANONYMIZATION_ERROR_CODE.sourceChanged;
  }
  const signal = AbortSignal.timeout(PDF_ANONYMIZATION_WORKER_TIMEOUT_MS);
  const processed = await processPdfAnonymization({
    entityId: run.entityId,
    organizationId: actor.organizationId,
    scopedDb: actor.scopedDb,
    signal,
    source,
    workspaceId: actor.workspaceId,
  });
  if (Result.isError(processed)) {
    return processed.error.code;
  }
  if (processed.value.document.byteLength > PDF_RASTER_MAX_OUTPUT_BYTES) {
    return PDF_ANONYMIZATION_ERROR_CODE.rewriteFailed;
  }
  const fileName = outputFileName(run.sourceFileName);
  const scan = await scanFile({
    buffer: processed.value.document,
    declaredMimeType: PDF_MIME_TYPE,
    fileName,
  });
  if (Result.isError(scan) || scan.value.verdict === "reject") {
    return PDF_ANONYMIZATION_ERROR_CODE.outputRejected;
  }
  const sourceEntities = await actor.scopedDb((tx) =>
    tx
      .select({ parentId: entities.parentId })
      .from(entities)
      .where(
        and(
          eq(entities.id, run.entityId),
          eq(entities.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1),
  );
  const sourceEntity = sourceEntities.at(0);
  if (!sourceEntity) {
    return PDF_ANONYMIZATION_ERROR_CODE.sourceChanged;
  }
  const created = await createEntityFromBuffer({
    scopedDb: actor.scopedDb,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    recordAuditEvent: createAuditRecorder({
      execution: {
        performer: {
          type: "service",
          id: `pdf-anonymization:${actor.runId}`,
          name: "PDF anonymization",
        },
        trigger: {
          type: "user_dispatch",
          userId: actor.userId,
          source: "action",
        },
        runId: actor.runId,
      },
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      request: new Request("http://pdf-anonymization.internal/"),
      server: null,
    }),
    buffer: processed.value.document,
    fileName,
    mimeType: PDF_MIME_TYPE,
    parentId: sourceEntity.parentId,
    scanWarnings: getScanWarnings(scan.value) ?? undefined,
    afterCreate: async (tx, output) => {
      // audit: skip; completion commits with the audited output entity.
      const completed = await tx
        .update(pdfAnonymizationRuns)
        .set({
          status: "completed",
          errorCode: null,
          finishedAt: new Date(),
          pageCount: processed.value.pageCount,
          detectionCount: processed.value.detectionCount,
          certificate: processed.value.certificate,
          outputEntityId: output.entityId,
          outputFieldId: output.fieldId,
          outputFileName: output.fileName,
        })
        .where(
          and(
            eq(pdfAnonymizationRuns.id, actor.runId),
            eq(pdfAnonymizationRuns.status, "running"),
          ),
        )
        .returning({ id: pdfAnonymizationRuns.id });
      if (!completed.at(0)) {
        panic("PDF anonymization completion returned no run");
      }
    },
  });
  if (Result.isError(created)) {
    captureError(created.error, { runId: actor.runId });
    return PDF_ANONYMIZATION_ERROR_CODE.internal;
  }
  return null;
};

const processRunJob = async (
  data: PdfAnonymizationRunJobData,
): Promise<void> => {
  const actor = brandActor(data);
  const run = await claimRun(actor);
  if (run === null) {
    return;
  }
  const result = await Result.tryPromise({
    try: async () => await executeRun(actor, run),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    captureError(result.error, { runId: actor.runId });
    await setRunFailed(
      actor,
      result.error instanceof PdfAnonymizationProcessError
        ? result.error.code
        : PDF_ANONYMIZATION_ERROR_CODE.internal,
    );
    return;
  }
  if (result.value !== null) {
    await setRunFailed(actor, result.value);
  }
};

const enqueueRuns = async (
  runs: readonly EnqueuePdfAnonymizationRunArgs[],
): Promise<number> => {
  const outcomes = await Promise.all(
    runs.map(async (run) =>
      Result.tryPromise({
        try: async () => await enqueuePdfAnonymizationRun(run),
        catch: (cause) => cause,
      }),
    ),
  );
  let handedOff = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (Result.isError(outcome)) {
      captureError(outcome.error, { runId: runs.at(index)?.runId ?? "" });
      continue;
    }
    handedOff += 1;
  }
  return handedOff;
};

export const reconcilePdfAnonymizationRuns = async (): Promise<{
  failed: number;
  handedOff: number;
  recovered: number;
}> => {
  const now = new Date();
  const runningCutoff = new Date(Date.now() - STUCK_RUNNING_MS);
  const failed = await rootDb
    .update(pdfAnonymizationRuns)
    .set({
      status: "failed",
      errorCode: PDF_ANONYMIZATION_ERROR_CODE.internal,
      finishedAt: now,
    })
    .where(
      and(
        isNull(pdfAnonymizationRuns.requestedBy),
        eq(pdfAnonymizationRuns.status, "queued"),
      ),
    )
    .returning({ id: pdfAnonymizationRuns.id });
  const recovered = await rootDb
    .update(pdfAnonymizationRuns)
    .set({ status: "queued", errorCode: null, startedAt: null })
    .where(
      and(
        eq(pdfAnonymizationRuns.status, "running"),
        lt(pdfAnonymizationRuns.startedAt, runningCutoff),
      ),
    )
    .returning({ id: pdfAnonymizationRuns.id });
  const queued = await rootDb
    .select({
      id: pdfAnonymizationRuns.id,
      organizationId: pdfAnonymizationRuns.organizationId,
      requestedBy: pdfAnonymizationRuns.requestedBy,
      workspaceId: pdfAnonymizationRuns.workspaceId,
    })
    .from(pdfAnonymizationRuns)
    .where(eq(pdfAnonymizationRuns.status, "queued"))
    .orderBy(asc(pdfAnonymizationRuns.createdAt), asc(pdfAnonymizationRuns.id))
    .limit(RECONCILE_BATCH_MAX);
  const handedOff = await enqueueRuns(
    queued.flatMap((run) =>
      run.requestedBy === null
        ? []
        : [
            {
              runId: run.id,
              organizationId: run.organizationId,
              workspaceId: run.workspaceId,
              userId: brandPersistedUserId(run.requestedBy),
            },
          ],
    ),
  );
  return { failed: failed.length, handedOff, recovered: recovered.length };
};

export const initPdfAnonymizationRunWorker = () => {
  const worker = new Worker<PdfAnonymizationRunJobData>(
    QUEUE_NAME,
    async (job) => await processRunJob(job.data),
    { connection: createBullMqConnection(), concurrency: WORKER_CONCURRENCY },
  );
  worker.on("failed", (job, error) => {
    if (job) {
      setRunFailed(
        brandActor(job.data),
        PDF_ANONYMIZATION_ERROR_CODE.internal,
      ).catch((markError: unknown) =>
        captureError(markError, { runId: job.data.runId }),
      );
    }
    captureError(error, { runId: job?.data.runId ?? "" });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("pdf_anonymization.worker_error"),
  );
  const closeReconcile = startNonOverlappingInterval({
    intervalMs: RECONCILE_INTERVAL_MS,
    run: async () => {
      const result = await reconcilePdfAnonymizationRuns();
      if (result.failed > 0 || result.handedOff > 0 || result.recovered > 0) {
        logger.info("pdf_anonymization.reconciled", {
          failed: String(result.failed),
          handedOff: String(result.handedOff),
          recovered: String(result.recovered),
        });
      }
    },
    onError: (error) => {
      logger.error("pdf_anonymization.reconcile_failed", {
        "error.type": errorTag(error),
      });
    },
  });
  return {
    close: async () => {
      await closeReconcile();
      await worker.close();
    },
  };
};
