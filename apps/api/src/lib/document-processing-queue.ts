import { Result, TaggedError } from "better-result";
import { Queue, Worker } from "bullmq";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
  organizationSettings,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { encryptContent } from "@/api/lib/content-encryption";
import { detached } from "@/api/lib/detached";
import {
  DocumentOcrProviderError,
  recognizePdfText,
} from "@/api/lib/document-processing-provider";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { createFileKey } from "@/api/lib/file-key";
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
const REPAIR_SETTLE_DELAY_MS = 5 * 60 * 1000;
const REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES = [
  "policy_disabled",
  "workspace_unavailable",
] as const;

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
  requestSource,
  sourceFileId,
  sourceSha256Hex,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  requestSource: "repair" | "upload";
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
        requestSource,
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

export const isAutomaticOcrRepairCandidate = (
  content: FieldContent,
): content is Extract<FieldContent, { type: "file" }> =>
  content.type === "file" &&
  content.mimeType === PDF_MIME_TYPE &&
  !content.encrypted;

export const isReversibleAutomaticOcrCancellation = ({
  errorCode,
  status,
}: {
  errorCode: string | null;
  status: (typeof documentProcessingRuns.$inferSelect)["status"];
}): boolean => {
  if (status !== "cancelled") {
    return false;
  }
  return (
    errorCode === REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES[0] ||
    errorCode === REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES[1]
  );
};

const markRunCancelled = async (
  runId: SafeId<"documentProcessingRun">,
  cancellationCode:
    | "policy_disabled"
    | "source_superseded"
    | "workspace_unavailable",
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
  organizationId,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
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
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.status, "active"),
      ),
    )
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
        workspaces,
        and(
          eq(workspaces.id, run.workspaceId),
          eq(workspaces.organizationId, run.organizationId),
          eq(workspaces.status, "active"),
        ),
      )
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

export const requiresOcrPolicy = (
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"],
): boolean => requestSource !== "manual";

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

  const contexts = await rootDb
    .select({
      documentProcessingMode: organizationSettings.documentProcessingMode,
      workspaceStatus: workspaces.status,
    })
    .from(workspaces)
    .leftJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, workspaces.organizationId),
    )
    .where(
      and(
        eq(workspaces.id, run.workspaceId),
        eq(workspaces.organizationId, run.organizationId),
      ),
    )
    .limit(1);
  const context = contexts.at(0);
  if (context?.workspaceStatus !== "active") {
    await markRunCancelled(run.id, "workspace_unavailable");
    return;
  }
  if (
    requiresOcrPolicy(run.requestSource) &&
    context.documentProcessingMode !== "searchable-text"
  ) {
    await markRunCancelled(run.id, "policy_disabled");
    return;
  }

  const source = await readCurrentOcrSource({
    entityId: run.entityId,
    fieldId: run.fieldId,
    organizationId: run.organizationId,
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

const earlierFileFields = alias(
  fields,
  "document_processing_earlier_file_fields",
);

type AutomaticOcrCandidate = {
  content: FieldContent;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

const reviveReversibleAutomaticOcrRun = async (
  candidate: AutomaticOcrCandidate,
): Promise<SafeId<"documentProcessingRun"> | null> => {
  if (!isAutomaticOcrRepairCandidate(candidate.content)) {
    return null;
  }

  const revived = await rootDb
    .update(documentProcessingRuns)
    .set({
      errorAt: null,
      errorCode: null,
      finishedAt: null,
      nextAttemptAt: null,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.organizationId, candidate.organizationId),
        eq(documentProcessingRuns.workspaceId, candidate.workspaceId),
        eq(documentProcessingRuns.entityId, candidate.entityId),
        eq(documentProcessingRuns.entityVersionId, candidate.entityVersionId),
        eq(documentProcessingRuns.fieldId, candidate.fieldId),
        eq(documentProcessingRuns.sourceFileId, candidate.content.id),
        eq(documentProcessingRuns.sourceSha256Hex, candidate.content.sha256Hex),
        eq(documentProcessingRuns.kind, "ocr"),
        eq(documentProcessingRuns.processorVersion, 1),
        inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
        eq(documentProcessingRuns.status, "cancelled"),
        inArray(
          documentProcessingRuns.errorCode,
          REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES,
        ),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return revived.at(0)?.id ?? null;
};

type EnqueueAttemptResult =
  | {
      status: "enqueued";
      runId: SafeId<"documentProcessingRun">;
    }
  | {
      status: "failed";
      runId: SafeId<"documentProcessingRun">;
    };

const tryEnqueueDocumentProcessingRun = async (
  runId: SafeId<"documentProcessingRun">,
): Promise<EnqueueAttemptResult> => {
  const result = await Result.tryPromise({
    try: async () => {
      await enqueueDocumentProcessingRun(runId);
      return undefined;
    },
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    captureError(result.error, { runId });
    return { runId, status: "failed" };
  }
  return { runId, status: "enqueued" };
};

const recoverMissingAutomaticOcrRuns = async (): Promise<number> => {
  const settledBefore = new Date(Date.now() - REPAIR_SETTLE_DELAY_MS);
  const candidates = await rootDb
    .select({
      content: fields.content,
      entityId: entities.id,
      entityVersionId: entityVersions.id,
      fieldId: fields.id,
      organizationId: workspaces.organizationId,
      workspaceId: workspaces.id,
    })
    .from(fields)
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, fields.entityVersionId),
        eq(entityVersions.workspaceId, fields.workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      entities,
      and(
        eq(entities.currentVersionId, entityVersions.id),
        eq(entities.id, entityVersions.entityId),
        eq(entities.workspaceId, fields.workspaceId),
        eq(entities.readOnly, false),
      ),
    )
    .innerJoin(workspaces, eq(workspaces.id, fields.workspaceId))
    .innerJoin(
      organizationSettings,
      and(
        eq(organizationSettings.organizationId, workspaces.organizationId),
        eq(organizationSettings.documentProcessingMode, "searchable-text"),
      ),
    )
    .leftJoin(extractedContent, eq(extractedContent.entityId, entities.id))
    .where(
      and(
        or(
          isNull(extractedContent.entityId),
          lt(extractedContent.extractedAt, entityVersions.createdAt),
        ),
        lt(entityVersions.createdAt, settledBefore),
        eq(workspaces.status, "active"),
        sql`${fields.content}->>'type' = 'file'
          AND ${fields.content}->>'mimeType' = 'application/pdf'
          AND ${fields.content}->>'encrypted' = 'false'`,
        notExists(
          rootDb
            .select({ id: earlierFileFields.id })
            .from(earlierFileFields)
            .where(
              and(
                eq(earlierFileFields.workspaceId, fields.workspaceId),
                eq(earlierFileFields.entityVersionId, fields.entityVersionId),
                lt(earlierFileFields.id, fields.id),
                sql`${earlierFileFields.content}->>'type' = 'file'`,
              ),
            ),
        ),
        notExists(
          rootDb
            .select({ id: documentProcessingRuns.id })
            .from(documentProcessingRuns)
            .where(
              and(
                eq(
                  documentProcessingRuns.organizationId,
                  workspaces.organizationId,
                ),
                eq(documentProcessingRuns.kind, "ocr"),
                eq(documentProcessingRuns.entityVersionId, entityVersions.id),
                eq(documentProcessingRuns.fieldId, fields.id),
                eq(
                  documentProcessingRuns.sourceFileId,
                  sql`(${fields.content}->>'id')::uuid`,
                ),
                eq(
                  documentProcessingRuns.sourceSha256Hex,
                  sql`${fields.content}->>'sha256Hex'`,
                ),
                eq(documentProcessingRuns.processorVersion, 1),
                or(
                  ne(documentProcessingRuns.status, "cancelled"),
                  isNull(documentProcessingRuns.errorCode),
                  and(
                    eq(documentProcessingRuns.status, "cancelled"),
                    eq(documentProcessingRuns.requestSource, "manual"),
                  ),
                  and(
                    eq(documentProcessingRuns.status, "cancelled"),
                    ne(documentProcessingRuns.errorCode, "policy_disabled"),
                    ne(
                      documentProcessingRuns.errorCode,
                      "workspace_unavailable",
                    ),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      asc(fields.workspaceId),
      asc(fields.entityVersionId),
      asc(fields.id),
    )
    .limit(RECONCILE_BATCH_SIZE);

  const values: (typeof documentProcessingRuns.$inferInsert)[] = [];
  for (const candidate of candidates) {
    const content = candidate.content;
    if (!isAutomaticOcrRepairCandidate(content)) {
      continue;
    }
    values.push({
      id: createSafeId<"documentProcessingRun">(),
      entityId: candidate.entityId,
      entityVersionId: candidate.entityVersionId,
      fieldId: candidate.fieldId,
      kind: "ocr",
      organizationId: candidate.organizationId,
      processorVersion: 1,
      requestedBy: null,
      requestSource: "repair",
      sourceFileId: content.id,
      sourceSha256Hex: content.sha256Hex,
      workspaceId: candidate.workspaceId,
    });
  }
  if (values.length === 0) {
    return 0;
  }

  const revivedIds = await Promise.all(
    candidates.map(reviveReversibleAutomaticOcrRun),
  );

  const inserted = await rootDb
    .insert(documentProcessingRuns)
    .values(values)
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

  const runIds = [
    ...inserted.map(({ id }) => id),
    ...revivedIds.filter(
      (id): id is SafeId<"documentProcessingRun"> => id !== null,
    ),
  ];
  await Promise.all(runIds.map(tryEnqueueDocumentProcessingRun));
  return runIds.length;
};

const updateQueuedRunSchedule = async ({
  delayMs,
  runIds,
  updatedAt,
}: {
  delayMs: number;
  runIds: SafeId<"documentProcessingRun">[];
  updatedAt: Date;
}): Promise<void> => {
  if (runIds.length === 0) {
    return;
  }
  await rootDb
    .update(documentProcessingRuns)
    .set({
      nextAttemptAt: new Date(updatedAt.getTime() + delayMs),
      updatedAt,
    })
    .where(
      and(
        inArray(documentProcessingRuns.id, runIds),
        eq(documentProcessingRuns.status, "queued"),
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

  const attempts = await Promise.all(
    runs.map(async ({ id }) => await tryEnqueueDocumentProcessingRun(id)),
  );
  const enqueuedIds: SafeId<"documentProcessingRun">[] = [];
  const failedIds: SafeId<"documentProcessingRun">[] = [];
  for (const attempt of attempts) {
    switch (attempt.status) {
      case "enqueued":
        enqueuedIds.push(attempt.runId);
        break;
      case "failed":
        failedIds.push(attempt.runId);
        break;
      default:
        attempt satisfies never;
    }
  }

  const updatedAt = new Date();
  await updateQueuedRunSchedule({
    delayMs: ENQUEUE_VISIBILITY_TIMEOUT_MS,
    runIds: enqueuedIds,
    updatedAt,
  });
  await updateQueuedRunSchedule({
    delayMs: ENQUEUE_FAILURE_RETRY_MS,
    runIds: failedIds,
    updatedAt,
  });
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

const handleDocumentProcessingFailure = async ({
  error,
  job,
}: {
  error: unknown;
  job: { data: DocumentProcessingJobData } | undefined;
}): Promise<void> => {
  if (job) {
    const markResult = await Result.tryPromise({
      try: async () => {
        await markRunFailed(job.data.runId, error);
        return undefined;
      },
      catch: (cause) => cause,
    });
    if (Result.isError(markResult)) {
      captureError(markResult.error, { runId: job.data.runId });
    }
  }
  captureError(error, { runId: job?.data.runId ?? "" });
  logger.error("document_processing.failed", {
    "error.type": errorTag(error),
    runId: job?.data.runId ?? "",
  });
};

const reconcileDocumentProcessing = async ({
  onComplete,
}: {
  onComplete: () => void;
}): Promise<void> => {
  try {
    const repairedCount = await recoverMissingAutomaticOcrRuns();
    const recoveredCount = await recoverStaleDocumentProcessingRuns();
    const enqueuedCount = await enqueueQueuedRuns();
    if (repairedCount > 0 || recoveredCount > 0 || enqueuedCount > 0) {
      logger.info("document_processing.reconciled", {
        enqueuedCount: String(enqueuedCount),
        recoveredCount: String(recoveredCount),
        repairedCount: String(repairedCount),
      });
    }
  } catch (error) {
    captureError(error);
    logger.error("document_processing.reconcile_failed", {
      "error.type": errorTag(error),
    });
  } finally {
    onComplete();
  }
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
    detached(
      handleDocumentProcessingFailure({ error, job }),
      "document-processing.mark-failed",
    );
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
    detached(
      reconcileDocumentProcessing({
        onComplete: () => {
          reconciling = false;
        },
      }),
      "document-processing.reconcile",
    );
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
