import { Result, panic } from "better-result";
import { type Queue, Worker } from "bullmq";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import {
  applyFolioAIEditsToBuffer,
  createBilingualDocx,
  readBilingualDocx,
} from "@stll/folio-core/server";

import { rootDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  documentTranslationRuns,
  documentTranslationUnits,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  decideDispositions,
  proposeGlossary,
  translateFormattedBatch,
} from "@/api/lib/bilingual/ai";
import type {
  BilingualAIContext,
  TranslationContextRow,
} from "@/api/lib/bilingual/ai";
import {
  BILINGUAL_LIMITS,
  BILINGUAL_ROW_DISPOSITION,
} from "@/api/lib/bilingual/contract";
import {
  applyFormattedBilingualTranslations,
  extractFormattedBilingualUnits,
} from "@/api/lib/bilingual/formatting";
import type {
  BilingualFormattedTranslation,
  FormattedBilingualUnit,
} from "@/api/lib/bilingual/formatting";
import { buildFormattingPreservingOperations } from "@/api/lib/bilingual/operations";
import type { StoredRow } from "@/api/lib/bilingual/operations";
import {
  detectGlossaryCandidates,
  flattenBilingualRows,
} from "@/api/lib/bilingual/rows";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { decryptContent } from "@/api/lib/content-encryption";
import { translateDocument, translateTextBatches } from "@/api/lib/deepl/deepl";
import { translateTaggedSegments } from "@/api/lib/document-translation/ai";
import { runBilingualTranslationBatches } from "@/api/lib/document-translation/bilingual-batch-runner";
import {
  commentTaggedText,
  unwrapCommentTranslation,
} from "@/api/lib/document-translation/comment-markers";
import {
  DOCUMENT_TRANSLATION_COMMENT_POLICY,
  DOCUMENT_TRANSLATION_ENGINE,
  DOCUMENT_TRANSLATION_LIMITS,
  DOCUMENT_TRANSLATION_OUTPUT,
  DOCUMENT_TRANSLATION_RUN_ACTIVE_STATUSES,
} from "@/api/lib/document-translation/contract";
import type {
  DocumentTranslationCommentPolicy,
  DocumentTranslationEngine,
  DocumentTranslationOutput,
  DocumentTranslationRunErrorCode,
  DocumentTranslationRunStatus,
} from "@/api/lib/document-translation/contract";
import { mapDeepLCommentTranslations } from "@/api/lib/document-translation/deepl-comments";
import {
  applyDocxCommentPolicy,
  type DocxCommentTranslationUnit,
  DocxReviewError,
  readDocxCommentTranslationUnits,
  resolveDocxToFinal,
} from "@/api/lib/document-translation/docx-review";
import {
  buildBilingualFileName,
  resolveTranslatedOutput,
} from "@/api/lib/document-translation/output";
import { documentTranslationProviderErrorCode } from "@/api/lib/document-translation/provider-error";
import {
  applyDocxTranslationSegments,
  DocxTranslationError,
  extractDocxTranslationSegments,
} from "@/api/lib/document-translation/segments";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { errorTag } from "@/api/lib/errors/utils";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { createFileKey } from "@/api/lib/files/utils";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import {
  brandPersistedDocumentTranslationRunId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { withTimeout } from "@/api/lib/with-timeout";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "document-translation-runs";
const JOB_NAME = "run-document-translation";
const WORKER_CONCURRENCY = 2;
const JOB_ATTEMPTS = 1;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_RUNNING_MS = 60 * 60 * 1000;
const RECONCILE_BATCH_MAX = 100;

type DocumentTranslationRunJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

type DocumentTranslationRunQueue = Pick<
  Queue<DocumentTranslationRunJobData>,
  "add" | "getJob"
>;

export type EnqueueDocumentTranslationRunArgs = {
  runId: SafeId<"documentTranslationRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<DocumentTranslationRunJobData>({
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
}: EnqueueDocumentTranslationRunArgs) => ({
  name: JOB_NAME,
  data: { runId, workspaceId, organizationId, userId },
  opts: { jobId: createBullMqJobId(workspaceId, runId) },
});

export const enqueueDocumentTranslationRun = async (
  args: EnqueueDocumentTranslationRunArgs,
): Promise<void> => {
  await enqueueDocumentTranslationRunJob({ args, queue: getQueue() });
};

export const enqueueDocumentTranslationRunJob = async ({
  args,
  operationTimeoutMs = QUEUE_OPERATION_TIMEOUT_MS,
  queue,
}: {
  args: EnqueueDocumentTranslationRunArgs;
  operationTimeoutMs?: number;
  queue: DocumentTranslationRunQueue;
}): Promise<void> => {
  const { name, data, opts } = runJob(args);
  const existing = await withTimeout(
    async () => await queue.getJob(opts.jobId),
    {
      label: "document-translation.queue.get-job",
      timeoutMs: operationTimeoutMs,
    },
  );
  if (existing) {
    const state = await withTimeout(async () => await existing.getState(), {
      label: "document-translation.queue.get-state",
      timeoutMs: operationTimeoutMs,
    });
    if (state === "failed") {
      await withTimeout(async () => await existing.retry(), {
        label: "document-translation.queue.retry-job",
        timeoutMs: operationTimeoutMs,
      });
      return;
    }
    if (state !== "completed") {
      return;
    }
    await withTimeout(async () => await existing.remove(), {
      label: "document-translation.queue.remove-job",
      timeoutMs: operationTimeoutMs,
    });
  }
  await withTimeout(async () => await queue.add(name, data, opts), {
    label: "document-translation.queue.add-job",
    timeoutMs: operationTimeoutMs,
  });
};

const enqueueDocumentTranslationRuns = async (
  runs: readonly EnqueueDocumentTranslationRunArgs[],
): Promise<number> => {
  const outcomes = await Promise.all(
    runs.map(
      async (run) =>
        await Result.tryPromise({
          try: async () => await enqueueDocumentTranslationRun(run),
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

type RunActor = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  runId: SafeId<"documentTranslationRun">;
};

const brandActor = (data: DocumentTranslationRunJobData): RunActor => {
  const branded = brandValidatedWorkflowActorKey({
    organizationId: data.organizationId,
    workspaceId: data.workspaceId,
  });
  const userId = brandPersistedUserId(data.userId);
  const tenant = {
    organizationId: branded.organizationId,
    userId,
    workspaceIds: [branded.workspaceId],
  };
  return {
    organizationId: branded.organizationId,
    workspaceId: branded.workspaceId,
    userId,
    runId: brandPersistedDocumentTranslationRunId(data.runId),
    scopedDb: createRootScopedDb(tenant),
    safeDb: createRootSafeDb(tenant),
  };
};

type ClaimedRun = {
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  sourceFileId: SafeId<"userFile">;
  sourceFileName: string;
  sourceMimeType: string;
  output: DocumentTranslationOutput;
  engine: DocumentTranslationEngine;
  commentPolicy: DocumentTranslationCommentPolicy | null;
  sourceLang: string;
  targetLang: string;
};

const claimRun = async (actor: RunActor): Promise<ClaimedRun | null> => {
  const claimed = await actor.scopedDb(async (tx) => {
    // audit: skip — lifecycle bookkeeping on the run audited at create.
    const rows = await tx
      .update(documentTranslationRuns)
      .set({ status: "preparing", startedAt: new Date() })
      .where(
        and(
          eq(documentTranslationRuns.id, actor.runId),
          eq(documentTranslationRuns.workspaceId, actor.workspaceId),
          eq(documentTranslationRuns.status, "queued"),
        ),
      )
      .returning({
        entityId: documentTranslationRuns.entityId,
        fileFieldId: documentTranslationRuns.fileFieldId,
        entityVersionId: documentTranslationRuns.entityVersionId,
        sourceFileId: documentTranslationRuns.sourceFileId,
        sourceFileName: documentTranslationRuns.sourceFileName,
        sourceMimeType: documentTranslationRuns.sourceMimeType,
        output: documentTranslationRuns.output,
        engine: documentTranslationRuns.engine,
        commentPolicy: documentTranslationRuns.commentPolicy,
        sourceLang: documentTranslationRuns.sourceLang,
        targetLang: documentTranslationRuns.targetLang,
      });
    return rows.at(0);
  });
  if (!claimed) {
    return null;
  }
  return { ...claimed, sourceLang: claimed.sourceLang ?? "auto" };
};

type ActiveRunStage = Extract<
  DocumentTranslationRunStatus,
  "preparing" | "translating" | "assembling" | "validating"
>;

const transitionStage = async (
  actor: RunActor,
  from: ActiveRunStage,
  to: ActiveRunStage,
): Promise<boolean> =>
  await actor.scopedDb(async (tx) => {
    // audit: skip — lifecycle bookkeeping on the run audited at create.
    const transitioned = await tx
      .update(documentTranslationRuns)
      .set({ status: to })
      .where(
        and(
          eq(documentTranslationRuns.id, actor.runId),
          eq(documentTranslationRuns.status, from),
        ),
      )
      .returning({ id: documentTranslationRuns.id });
    return transitioned.length === 1;
  });

const failRedeliveredRun = async (actor: RunActor): Promise<boolean> =>
  await actor.scopedDb(async (tx) => {
    // A stalled BullMQ delivery means the previous worker lost its lease. AI
    // calls are intentionally one-shot, so fail the durable run immediately
    // rather than resuming it and double-spending metered work. Every later
    // stage transition is compare-and-set, fencing the stale worker before it
    // can publish an output.
    const failed = await tx
      .update(documentTranslationRuns)
      .set({ status: "failed", errorCode: "internal", finishedAt: new Date() })
      .where(
        and(
          eq(documentTranslationRuns.id, actor.runId),
          eq(documentTranslationRuns.workspaceId, actor.workspaceId),
          inArray(documentTranslationRuns.status, [
            "preparing",
            "translating",
            "assembling",
            "validating",
          ]),
        ),
      )
      .returning({ id: documentTranslationRuns.id });
    return failed.length === 1;
  });

const setRunFailed = async (
  actor: RunActor,
  errorCode: DocumentTranslationRunErrorCode,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — lifecycle bookkeeping on the run audited at create.
    await tx
      .update(documentTranslationRuns)
      .set({ status: "failed", errorCode, finishedAt: new Date() })
      .where(
        and(
          eq(documentTranslationRuns.id, actor.runId),
          inArray(documentTranslationRuns.status, [
            ...DOCUMENT_TRANSLATION_RUN_ACTIVE_STATUSES,
          ]),
        ),
      );
  });
};

type SourceBytes = { buffer: ArrayBuffer };

const loadPinnedSource = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<Result<SourceBytes, DocumentTranslationRunErrorCode>> => {
  const current = await actor.safeDb((tx) =>
    tx
      .select({
        entityVersionId: entityVersions.id,
        content: fields.content,
      })
      .from(entities)
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, entities.currentVersionId),
          eq(entityVersions.entityId, entities.id),
        ),
      )
      .innerJoin(
        fields,
        and(
          eq(fields.id, run.fileFieldId),
          eq(fields.entityVersionId, entityVersions.id),
        ),
      )
      .where(
        and(
          eq(entities.id, run.entityId),
          eq(entities.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1),
  );
  if (Result.isError(current)) {
    return Result.err("document_unresolved");
  }
  const source = current.value.at(0);
  if (!source || source.content.type !== "file" || source.content.encrypted) {
    return Result.err("document_unresolved");
  }
  if (
    source.entityVersionId !== run.entityVersionId ||
    source.content.id !== run.sourceFileId ||
    source.content.mimeType !== run.sourceMimeType
  ) {
    return Result.err("document_changed");
  }
  const bytes = await Result.tryPromise({
    try: async () =>
      await readS3ArrayBuffer(
        createFileKey({
          organizationId: actor.organizationId,
          workspaceId: actor.workspaceId,
          fileId: run.sourceFileId,
          mimeType: run.sourceMimeType,
        }),
      ),
    catch: (cause) => cause,
  });
  return Result.isError(bytes)
    ? Result.err("document_unresolved")
    : Result.ok({ buffer: bytes.value });
};

const createAIContext = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<BilingualAIContext> => ({
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
  orgAIConfig: await loadOrgAIConfig(actor.organizationId),
  promptCachingEnabled: await loadPromptCachingPreference(actor.organizationId),
  abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  scopeKey: run.entityVersionId,
  usageMetering: {
    actionType: "doc_review",
    organizationId: actor.organizationId,
    safeDb: actor.safeDb,
    serviceTier: "standard",
    userId: actor.userId,
    workspaceId: actor.workspaceId,
  },
});

const setTotal = async (actor: RunActor, total: number): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — progress bookkeeping on the run audited at create.
    await tx
      .update(documentTranslationRuns)
      .set({ total, completed: 0 })
      .where(eq(documentTranslationRuns.id, actor.runId));
  });
};

const updateTranslatedUnits = async (
  actor: RunActor,
  updates: readonly { unitKey: string; targetText: string }[],
): Promise<void> => {
  if (updates.length === 0) {
    return;
  }
  await actor.scopedDb(async (tx) => {
    // audit: skip — unit and progress bookkeeping inside the audited run.
    const values = sql.join(
      updates.map((update) => sql`(${update.unitKey}, ${update.targetText})`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE ${documentTranslationUnits} AS u
      SET status = 'translated', target_text = v.target_text, updated_at = now()
      FROM (VALUES ${values}) AS v(unit_key, target_text)
      WHERE u.run_id = ${actor.runId}
        AND u.workspace_id = ${actor.workspaceId}
        AND u.unit_key = v.unit_key
    `);
    await tx
      .update(documentTranslationRuns)
      .set({
        completed: sql`LEAST(${documentTranslationRuns.total}, ${documentTranslationRuns.completed} + ${updates.length})`,
      })
      .where(eq(documentTranslationRuns.id, actor.runId));
  });
};

type TranslationOutput = {
  buffer: ArrayBuffer | Uint8Array;
  fileName: string;
  mimeType: string;
  warnings: string[];
};

const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const loadDeepLApiKey = async (
  actor: RunActor,
): Promise<Result<string, "provider_unavailable">> => {
  const settings = await actor.safeDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: actor.organizationId } },
      columns: { deeplApiKeyEncrypted: true, deeplApiKeyIv: true },
    }),
  );
  if (Result.isError(settings)) {
    return Result.err("provider_unavailable");
  }
  const ciphertext = settings.value?.deeplApiKeyEncrypted;
  const iv = settings.value?.deeplApiKeyIv;
  if (!ciphertext || !iv) {
    return Result.err("provider_unavailable");
  }
  const decrypted = await Result.tryPromise({
    try: async () => await decryptContent(actor.organizationId, ciphertext, iv),
    catch: (cause) => cause,
  });
  if (Result.isError(decrypted)) {
    captureError(decrypted.error, { runId: actor.runId });
    return Result.err("provider_unavailable");
  }
  return Result.ok(decrypted.value);
};

const translateCommentsWithAI = async (
  actor: RunActor,
  comments: readonly DocxCommentTranslationUnit[],
  run: ClaimedRun,
  context: BilingualAIContext,
): Promise<Result<Map<number, string>, DocumentTranslationRunErrorCode>> => {
  const translated = new Map<number, string>();
  for (const comment of comments) {
    if (comment.text === "") {
      translated.set(comment.id, "");
    }
  }
  const pending = comments.filter((comment) => comment.text !== "");
  const translateNextBatch = async (
    index: number,
  ): Promise<Result<void, DocumentTranslationRunErrorCode>> => {
    if (index >= pending.length) {
      return Result.ok();
    }
    const batch = pending.slice(
      index,
      index + DOCUMENT_TRANSLATION_LIMITS.batchSize,
    );
    const response = await Result.tryPromise({
      try: async () =>
        await translateTaggedSegments({
          segments: batch.map((comment) => ({
            id: `comment:${comment.id}`,
            taggedText: commentTaggedText(comment),
          })),
          preceding: [],
          sourceLang: run.sourceLang,
          targetLang: run.targetLang,
          context,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(response)) {
      captureError(response.error, { runId: actor.runId });
      return Result.err(documentTranslationProviderErrorCode(response.error));
    }
    for (const comment of batch) {
      const tagged = response.value.get(`comment:${comment.id}`);
      const text =
        tagged === undefined ? null : unwrapCommentTranslation(comment, tagged);
      if (text === null) {
        return Result.err("translation_failed");
      }
      translated.set(comment.id, text);
    }
    return await translateNextBatch(
      index + DOCUMENT_TRANSLATION_LIMITS.batchSize,
    );
  };
  const result = await translateNextBatch(0);
  return Result.isError(result) ? result : Result.ok(translated);
};

const translateCommentsWithDeepL = async (
  actor: RunActor,
  comments: readonly DocxCommentTranslationUnit[],
  run: ClaimedRun,
  apiKey: string,
): Promise<Result<Map<number, string>, DocumentTranslationRunErrorCode>> => {
  const pending = comments.filter((comment) => comment.text !== "");
  const response = await Result.tryPromise({
    try: async () =>
      await translateTextBatches({
        apiKey,
        texts: pending.map((comment) => comment.text),
        targetLang: run.targetLang,
        sourceLang: run.sourceLang === "auto" ? undefined : run.sourceLang,
        formality: "prefer_more",
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(response)) {
    captureError(response.error, { runId: actor.runId });
    return Result.err(documentTranslationProviderErrorCode(response.error));
  }
  return mapDeepLCommentTranslations(comments, response.value);
};

const translateWithDeepL = async (
  actor: RunActor,
  run: ClaimedRun,
  source: ArrayBuffer,
  apiKey: string,
): Promise<Result<TranslationOutput, DocumentTranslationRunErrorCode>> => {
  const translated = await Result.tryPromise({
    try: async () =>
      await translateDocument({
        apiKey,
        file: new Uint8Array(source),
        fileName: run.sourceFileName,
        mimeType: run.sourceMimeType,
        targetLang: run.targetLang,
        sourceLang: run.sourceLang === "auto" ? undefined : run.sourceLang,
        formality: "prefer_more",
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(translated)) {
    captureError(translated.error, { runId: actor.runId });
    return Result.err(documentTranslationProviderErrorCode(translated.error));
  }
  const output = resolveTranslatedOutput({
    sourceFileName: run.sourceFileName,
    sourceMimeType: run.sourceMimeType,
    targetLang: run.targetLang,
  });
  await setTotal(actor, 1);
  await actor.scopedDb(async (tx) => {
    await tx
      .update(documentTranslationRuns)
      .set({ completed: 1 })
      .where(eq(documentTranslationRuns.id, actor.runId));
  });
  return Result.ok({
    buffer: translated.value.bytes,
    fileName: output.fileName,
    mimeType: output.mimeType,
    warnings: [],
  });
};

const translateDocxWithAI = async (
  actor: RunActor,
  run: ClaimedRun,
  source: ArrayBuffer,
  context: BilingualAIContext,
): Promise<Result<TranslationOutput, DocumentTranslationRunErrorCode>> => {
  const extracted = await Result.tryPromise({
    try: async () => await extractDocxTranslationSegments(source),
    catch: (cause) => cause,
  });
  if (Result.isError(extracted)) {
    return Result.err(
      DocxTranslationError.is(extracted.error) &&
        extracted.error.reason === "unsupported-review-markup"
        ? "unsupported_review_markup"
        : "unsupported_format",
    );
  }
  const allSegments = extracted.value.segments;
  const segments = allSegments.filter((segment) => segment.text.trim() !== "");
  if (
    segments.length === 0 ||
    segments.length > DOCUMENT_TRANSLATION_LIMITS.unitsMax ||
    segments.some(
      (segment) =>
        segment.taggedText.length > DOCUMENT_TRANSLATION_LIMITS.unitTextMax,
    )
  ) {
    return Result.err("unsupported_format");
  }
  await actor.scopedDb(async (tx) => {
    await tx.insert(documentTranslationUnits).values(
      segments.map((segment, ordinal) => ({
        id: createSafeId<"documentTranslationUnit">(),
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        runId: actor.runId,
        unitKey: segment.segmentId,
        ordinal,
        sourceText: segment.text,
        application: {
          type: "docxSegment" as const,
          segmentId: segment.segmentId,
          taggedSourceText: segment.taggedText,
        },
      })),
    );
  });
  await setTotal(actor, segments.length);

  const translated = new Map<string, string>();
  const translateNextBatch = async (
    index: number,
  ): Promise<Result<void, DocumentTranslationRunErrorCode>> => {
    if (index >= segments.length) {
      return Result.ok();
    }
    const batch = segments.slice(
      index,
      index + DOCUMENT_TRANSLATION_LIMITS.batchSize,
    );
    const preceding = segments
      .slice(0, index)
      .slice(-DOCUMENT_TRANSLATION_LIMITS.contextUnits);
    const result = await Result.tryPromise({
      try: async () =>
        await translateTaggedSegments({
          segments: batch.map((segment) => ({
            id: segment.segmentId,
            taggedText: segment.taggedText,
          })),
          preceding: preceding.map((segment) => ({
            id: segment.segmentId,
            taggedText: translated.get(segment.segmentId) ?? segment.taggedText,
          })),
          sourceLang: run.sourceLang,
          targetLang: run.targetLang,
          context,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(result)) {
      captureError(result.error, { runId: actor.runId });
      return Result.err(documentTranslationProviderErrorCode(result.error));
    }
    const updates: { unitKey: string; targetText: string }[] = [];
    for (const segment of batch) {
      const targetText = result.value.get(segment.segmentId);
      if (targetText === undefined) {
        return Result.err("translation_failed");
      }
      translated.set(segment.segmentId, targetText);
      updates.push({ unitKey: segment.segmentId, targetText });
    }
    await updateTranslatedUnits(actor, updates);
    return await translateNextBatch(
      index + DOCUMENT_TRANSLATION_LIMITS.batchSize,
    );
  };
  const translation = await translateNextBatch(0);
  if (Result.isError(translation)) {
    return translation;
  }

  if (!(await transitionStage(actor, "translating", "assembling"))) {
    return Result.err("internal");
  }
  const applied = await Result.tryPromise({
    try: async () =>
      await applyDocxTranslationSegments(
        source,
        allSegments.map((segment) => ({
          segmentId: segment.segmentId,
          taggedText: translated.get(segment.segmentId) ?? segment.taggedText,
        })),
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(applied)) {
    captureError(applied.error, { runId: actor.runId });
    return Result.err("format_validation_failed");
  }
  const output = resolveTranslatedOutput({
    sourceFileName: run.sourceFileName,
    sourceMimeType: DOCX_MIME_TYPE,
    targetLang: run.targetLang,
  });
  return Result.ok({
    buffer: applied.value,
    fileName: output.fileName,
    mimeType: output.mimeType,
    warnings: [],
  });
};

const translateBilingualWithAI = async (
  actor: RunActor,
  run: ClaimedRun,
  source: ArrayBuffer,
  context: BilingualAIContext,
): Promise<Result<TranslationOutput, DocumentTranslationRunErrorCode>> => {
  const conversion = await Result.tryPromise({
    try: async () =>
      await createBilingualDocx(source, {
        targetStyleSuffix: run.targetLang,
        borders: "none",
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(conversion)) {
    return Result.err("unsupported_format");
  }
  const manifest = await Result.tryPromise({
    try: async () => await readBilingualDocx(conversion.value.buffer),
    catch: (cause) => cause,
  });
  if (Result.isError(manifest)) {
    return Result.err("unsupported_format");
  }
  const { units, dropped } = flattenBilingualRows(manifest.value);
  if (
    units.length === 0 ||
    units.length > BILINGUAL_LIMITS.rowsMax ||
    dropped > 0
  ) {
    return Result.err("unsupported_format");
  }
  const formatted = await Result.tryPromise({
    try: async () =>
      await extractFormattedBilingualUnits(conversion.value.buffer, units),
    catch: (cause) => cause,
  });
  if (Result.isError(formatted)) {
    return Result.err("unsupported_format");
  }
  const documentContext = {
    ...context,
    sourceDocument: formatted.value,
  };
  const languages = {
    sourceLang: run.sourceLang,
    targetLang: run.targetLang,
  };
  const texts = formatted.value.map((unit) => unit.sourceText);
  const prepared = await Result.tryPromise({
    try: async () => {
      const [rows, glossary] = await Promise.all([
        decideDispositions(formatted.value, languages, documentContext),
        proposeGlossary(
          detectGlossaryCandidates(texts),
          texts,
          languages,
          documentContext,
        ),
      ]);
      return { rows, glossary };
    },
    catch: (cause) => cause,
  });
  if (Result.isError(prepared)) {
    return Result.err(documentTranslationProviderErrorCode(prepared.error));
  }
  const rows: StoredRow[] = prepared.value.rows.map((row) => ({
    ...row,
    status: "pending",
    targetText: null,
  }));
  const pending = rows.filter(
    (row) => row.disposition !== BILINGUAL_ROW_DISPOSITION.KEEP,
  );
  if (pending.length === 0) {
    return Result.err("translation_failed");
  }
  await actor.scopedDb(async (tx) => {
    await tx.insert(documentTranslationUnits).values(
      rows.map((row) => ({
        id: createSafeId<"documentTranslationUnit">(),
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        runId: actor.runId,
        unitKey: row.rowId,
        ordinal: row.ordinal,
        sourceText: row.sourceText,
        application: {
          type: "bilingualRow" as const,
          rowId: row.rowId,
          kind: row.kind,
          inTable: row.inTable,
          disposition: row.disposition,
          sourceParaId: row.sourceParaId,
        },
      })),
    );
  });
  await setTotal(actor, pending.length);

  const translated = new Map<string, string>();
  const formattedTranslations = new Map<
    string,
    BilingualFormattedTranslation
  >();
  const formattedByRowId = new Map(
    formatted.value.map((unit) => [unit.rowId, unit]),
  );
  const translateBatch = async (
    batch: readonly StoredRow[],
  ): Promise<Result<void, DocumentTranslationRunErrorCode>> => {
    const first = batch.at(0);
    if (!first) {
      return Result.ok();
    }
    const preceding: TranslationContextRow[] = rows
      .filter(
        (row) =>
          row.ordinal < first.ordinal &&
          row.disposition !== BILINGUAL_ROW_DISPOSITION.KEEP,
      )
      .slice(-BILINGUAL_LIMITS.contextRows)
      .map((row) => ({
        sourceText: row.sourceText,
        targetText: translated.get(row.rowId) ?? null,
      }));
    const formattedBatch: FormattedBilingualUnit[] = [];
    for (const row of batch) {
      const formattedUnit = formattedByRowId.get(row.rowId);
      if (!formattedUnit) {
        return Result.err("translation_failed");
      }
      formattedBatch.push(formattedUnit);
    }
    const result = await Result.tryPromise({
      try: async () =>
        await translateFormattedBatch(
          {
            batch: formattedBatch,
            preceding,
            glossary: prepared.value.glossary,
          },
          languages,
          documentContext,
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(result)) {
      return Result.err(documentTranslationProviderErrorCode(result.error));
    }
    const updates: { unitKey: string; targetText: string }[] = [];
    for (const row of batch) {
      const formattedTranslation = result.value.get(row.ordinal);
      if (formattedTranslation === undefined) {
        return Result.err("translation_failed");
      }
      const targetText = formattedTranslation.text;
      translated.set(row.rowId, targetText);
      formattedTranslations.set(row.rowId, formattedTranslation);
      updates.push({ unitKey: row.rowId, targetText });
    }
    await updateTranslatedUnits(actor, updates);
    return Result.ok();
  };
  const translation = await runBilingualTranslationBatches({
    items: pending,
    translate: translateBatch,
  });
  if (Result.isError(translation)) {
    return translation;
  }

  if (!(await transitionStage(actor, "translating", "assembling"))) {
    return Result.err("internal");
  }
  const formattedBuffer = await Result.tryPromise({
    try: async () =>
      await applyFormattedBilingualTranslations(
        conversion.value.buffer,
        rows,
        formattedTranslations,
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(formattedBuffer)) {
    captureError(formattedBuffer.error, { runId: actor.runId });
    return Result.err("format_validation_failed");
  }
  const operations = buildFormattingPreservingOperations(
    rows,
    new Set(formattedTranslations.keys()),
  );
  const applied = await Result.tryPromise({
    try: async () =>
      await applyFolioAIEditsToBuffer(formattedBuffer.value, operations, {
        author: "Stella",
        mode: "direct",
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(applied)) {
    captureError(applied.error, { runId: actor.runId });
    return Result.err("format_validation_failed");
  }
  if (applied.value.skipped.length > 0) {
    logger.warn("document_translation.operations_skipped", {
      count: String(applied.value.skipped.length),
      reasons: [
        ...new Set(applied.value.skipped.map(({ reason }) => reason)),
      ].join(","),
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    return Result.err("format_validation_failed");
  }
  return Result.ok({
    buffer: applied.value.buffer,
    fileName: buildBilingualFileName({
      sourceFileName: run.sourceFileName,
      sourceLang: run.sourceLang,
      targetLang: run.targetLang,
    }),
    mimeType: DOCX_MIME_TYPE,
    warnings: conversion.value.warnings.slice(
      0,
      DOCUMENT_TRANSLATION_LIMITS.warningsMax,
    ),
  });
};

const executeRun = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<DocumentTranslationRunErrorCode | null> => {
  const loaded = await loadPinnedSource(actor, run);
  if (Result.isError(loaded)) {
    return loaded.error;
  }
  let source = loaded.value.buffer;
  let comments: DocxCommentTranslationUnit[] = [];
  if (run.sourceMimeType === DOCX_MIME_TYPE) {
    const prepared = await Result.tryPromise({
      try: async () => await resolveDocxToFinal(source),
      catch: (cause) => cause,
    });
    if (Result.isError(prepared)) {
      captureError(prepared.error, { runId: actor.runId });
      return DocxReviewError.is(prepared.error)
        ? "unsupported_review_markup"
        : "unsupported_format";
    }
    source = prepared.value;
    const readComments = await Result.tryPromise({
      try: async () => await readDocxCommentTranslationUnits(source),
      catch: (cause) => cause,
    });
    if (Result.isError(readComments)) {
      captureError(readComments.error, { runId: actor.runId });
      return "unsupported_format";
    }
    comments = readComments.value;
    if (
      comments.length > DOCUMENT_TRANSLATION_LIMITS.unitsMax ||
      comments.some(
        (comment) =>
          comment.text.length > DOCUMENT_TRANSLATION_LIMITS.unitTextMax,
      )
    ) {
      return "unsupported_format";
    }
  }
  // Runs queued before comment-policy support preserve source comments. New
  // requests cannot omit the choice when the pinned DOCX contains comments.
  const commentPolicy =
    run.commentPolicy ?? DOCUMENT_TRANSLATION_COMMENT_POLICY.ORIGINAL;
  if (!(await transitionStage(actor, "preparing", "translating"))) {
    return "internal";
  }

  let output: Result<TranslationOutput, DocumentTranslationRunErrorCode>;
  let commentTranslations = new Map<number, string>();
  if (run.engine === DOCUMENT_TRANSLATION_ENGINE.DEEPL) {
    const apiKey = await loadDeepLApiKey(actor);
    if (Result.isError(apiKey)) {
      return apiKey.error;
    }
    if (comments.length > 0 && commentPolicy !== "original") {
      const translatedComments = await translateCommentsWithDeepL(
        actor,
        comments,
        run,
        apiKey.value,
      );
      if (Result.isError(translatedComments)) {
        return translatedComments.error;
      }
      commentTranslations = translatedComments.value;
    }
    output = await translateWithDeepL(actor, run, source, apiKey.value);
  } else {
    const context = await Result.tryPromise({
      try: async () => await createAIContext(actor, run),
      catch: (cause) => cause,
    });
    if (Result.isError(context)) {
      return "provider_unavailable";
    }
    if (comments.length > 0 && commentPolicy !== "original") {
      const translatedComments = await translateCommentsWithAI(
        actor,
        comments,
        run,
        context.value,
      );
      if (Result.isError(translatedComments)) {
        return translatedComments.error;
      }
      commentTranslations = translatedComments.value;
    }
    if (run.output === DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED) {
      output = await translateDocxWithAI(actor, run, source, context.value);
    } else {
      output = await translateBilingualWithAI(
        actor,
        run,
        source,
        context.value,
      );
    }
  }
  if (Result.isError(output)) {
    return output.error;
  }
  let completedOutput = output.value;
  if (comments.length > 0) {
    const withComments = await Result.tryPromise({
      try: async () =>
        await applyDocxCommentPolicy({
          source,
          output:
            completedOutput.buffer instanceof Uint8Array
              ? copyToArrayBuffer(completedOutput.buffer)
              : completedOutput.buffer,
          policy: commentPolicy,
          translations: commentTranslations,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(withComments)) {
      captureError(withComments.error, { runId: actor.runId });
      return "format_validation_failed";
    }
    completedOutput = { ...completedOutput, buffer: withComments.value };
  }

  const outputStage =
    run.engine === DOCUMENT_TRANSLATION_ENGINE.DEEPL
      ? "translating"
      : "assembling";
  if (!(await transitionStage(actor, outputStage, "validating"))) {
    return "internal";
  }
  if (completedOutput.mimeType === DOCX_MIME_TYPE) {
    const validation = await validateDocxBuffer(
      completedOutput.buffer instanceof Uint8Array
        ? copyToArrayBuffer(completedOutput.buffer)
        : completedOutput.buffer,
    );
    if (!validation.valid) {
      return "format_validation_failed";
    }
  }
  const scan = await scanFile({
    buffer:
      completedOutput.buffer instanceof Uint8Array
        ? completedOutput.buffer
        : new Uint8Array(completedOutput.buffer),
    declaredMimeType: completedOutput.mimeType,
    fileName: completedOutput.fileName,
  });
  if (Result.isError(scan) || scan.value.verdict === "reject") {
    return "format_validation_failed";
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
          id: `document-translation:${actor.runId}`,
          name: "Document translation",
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
      request: new Request("http://document-translation.internal/"),
      server: null,
    }),
    buffer: completedOutput.buffer,
    fileName: completedOutput.fileName,
    mimeType: completedOutput.mimeType,
    scanWarnings: getScanWarnings(scan.value) ?? undefined,
    afterCreate: async (tx, createdOutput) => {
      // audit: skip — lifecycle bookkeeping committed atomically with the
      // audited output entity, preventing a completed file with a stuck run.
      const completed = await tx
        .update(documentTranslationRuns)
        .set({
          status: "completed",
          errorCode: null,
          finishedAt: new Date(),
          warnings: completedOutput.warnings,
          outputEntityId: createdOutput.entityId,
          outputFieldId: createdOutput.fieldId,
          outputFileName: createdOutput.fileName,
        })
        .where(
          and(
            eq(documentTranslationRuns.id, actor.runId),
            eq(documentTranslationRuns.status, "validating"),
          ),
        )
        .returning({ id: documentTranslationRuns.id });
      if (!completed.at(0)) {
        panic("Document translation completion returned no run");
      }
    },
  });
  if (Result.isError(created)) {
    captureError(created.error, { runId: actor.runId });
    return "internal";
  }
  return null;
};

const processRunJob = async (
  data: DocumentTranslationRunJobData,
): Promise<void> => {
  const actor = brandActor(data);
  const run = await claimRun(actor);
  if (run === null) {
    if (await failRedeliveredRun(actor)) {
      logger.warn("document_translation.redelivery_failed_run", {
        runId: actor.runId,
        workspaceId: actor.workspaceId,
      });
    }
    return;
  }
  const result = await Result.tryPromise({
    try: async () => await executeRun(actor, run),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    captureError(result.error, { runId: actor.runId });
    await setRunFailed(actor, "internal");
    return;
  }
  if (result.value !== null) {
    await setRunFailed(actor, result.value);
  }
};

type ReconcileDocumentTranslationRunsResult = {
  cancelled: number;
  failed: number;
  handedOff: number;
};

export const reconcileDocumentTranslationRuns =
  async (): Promise<ReconcileDocumentTranslationRunsResult> => {
    const runningCutoff = new Date(Date.now() - STUCK_RUNNING_MS);
    const cancelled = await rootDb
      .update(documentTranslationRuns)
      .set({ status: "cancelled", errorCode: null, finishedAt: new Date() })
      .where(
        and(
          inArray(documentTranslationRuns.status, [
            ...DOCUMENT_TRANSLATION_RUN_ACTIVE_STATUSES,
          ]),
          isNull(documentTranslationRuns.requestedBy),
        ),
      )
      .returning({ id: documentTranslationRuns.id });
    const queued = await rootDb
      .select({
        id: documentTranslationRuns.id,
        organizationId: documentTranslationRuns.organizationId,
        requestedBy: documentTranslationRuns.requestedBy,
        workspaceId: documentTranslationRuns.workspaceId,
      })
      .from(documentTranslationRuns)
      .where(eq(documentTranslationRuns.status, "queued"))
      .orderBy(
        asc(documentTranslationRuns.createdAt),
        asc(documentTranslationRuns.id),
      )
      .limit(RECONCILE_BATCH_MAX);
    const handedOff = await enqueueDocumentTranslationRuns(
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
    const recovered = await rootDb
      .update(documentTranslationRuns)
      .set({ status: "failed", errorCode: "internal", finishedAt: new Date() })
      .where(
        and(
          inArray(documentTranslationRuns.status, [
            "preparing",
            "translating",
            "assembling",
            "validating",
          ]),
          lt(documentTranslationRuns.startedAt, runningCutoff),
        ),
      )
      .returning({ id: documentTranslationRuns.id });
    return { cancelled: cancelled.length, failed: recovered.length, handedOff };
  };

export const initDocumentTranslationRunWorker = () => {
  const worker = new Worker<DocumentTranslationRunJobData>(
    QUEUE_NAME,
    async (job) => await processRunJob(job.data),
    { connection: createBullMqConnection(), concurrency: WORKER_CONCURRENCY },
  );
  worker.on("failed", (job, error) => {
    if (job) {
      setRunFailed(brandActor(job.data), "internal").catch(
        (markError: unknown) =>
          captureError(markError, { runId: job.data.runId }),
      );
    }
    captureError(error, { runId: job?.data.runId ?? "" });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("document_translation.worker_error"),
  );

  const closeReconcile = startNonOverlappingInterval({
    intervalMs: ORPHAN_RECONCILE_INTERVAL_MS,
    run: async () => {
      const result = await reconcileDocumentTranslationRuns();
      if (result.cancelled > 0 || result.failed > 0 || result.handedOff > 0) {
        logger.info("document_translation.reconciled", {
          cancelled: String(result.cancelled),
          failed: String(result.failed),
          handedOff: String(result.handedOff),
        });
      }
    },
    onError: (error) => {
      logger.error("document_translation.reconcile_failed", {
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
