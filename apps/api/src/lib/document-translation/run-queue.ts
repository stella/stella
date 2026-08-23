import { Result, panic } from "better-result";
import { Worker } from "bullmq";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

import {
  applyFolioAIEditsToBuffer,
  createBilingualDocx,
  readBilingualDocx,
} from "@stll/folio-core/server";
import { DAY_IN_MS } from "@stll/time";

import { rootDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  documentTranslationRuns,
  documentTranslationUnits,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { buildBilingualFileName } from "@/api/handlers/entities/bilingual/output";
import { resolveTranslatedOutput } from "@/api/handlers/entities/translate-output";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createAuditRecorder } from "@/api/lib/audit-log";
import {
  decideDispositions,
  proposeGlossary,
  translateBatch,
} from "@/api/lib/bilingual/ai";
import type {
  BilingualAIContext,
  TranslationContextRow,
} from "@/api/lib/bilingual/ai";
import {
  BILINGUAL_LIMITS,
  BILINGUAL_ROW_DISPOSITION,
} from "@/api/lib/bilingual/contract";
import { buildOperations } from "@/api/lib/bilingual/operations";
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
import { translateDocument } from "@/api/lib/deepl/deepl";
import { translateTaggedSegments } from "@/api/lib/document-translation/ai";
import {
  DOCUMENT_TRANSLATION_ENGINE,
  DOCUMENT_TRANSLATION_LIMITS,
  DOCUMENT_TRANSLATION_OUTPUT,
  DOCUMENT_TRANSLATION_RUN_ACTIVE_STATUSES,
} from "@/api/lib/document-translation/contract";
import type {
  DocumentTranslationEngine,
  DocumentTranslationOutput,
  DocumentTranslationRunErrorCode,
  DocumentTranslationRunStatus,
} from "@/api/lib/document-translation/contract";
import {
  applyDocxTranslationSegments,
  DocxTranslationError,
  extractDocxTranslationSegments,
} from "@/api/lib/document-translation/segments";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { createFileKey } from "@/api/lib/files/utils";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import {
  brandPersistedDocumentTranslationRunId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "document-translation-runs";
const JOB_NAME = "run-document-translation";
const WORKER_CONCURRENCY = 2;
const JOB_ATTEMPTS = 1;
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_RUNNING_MS = 60 * 60 * 1000;
const STUCK_QUEUED_MS = DAY_IN_MS;

type DocumentTranslationRunJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

export type EnqueueDocumentTranslationRunArgs = {
  runId: SafeId<"documentTranslationRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<DocumentTranslationRunJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const enqueueDocumentTranslationRun = async ({
  runId,
  workspaceId,
  organizationId,
  userId,
}: EnqueueDocumentTranslationRunArgs): Promise<void> => {
  await getQueue().add(
    JOB_NAME,
    { runId, workspaceId, organizationId, userId },
    { jobId: createBullMqJobId(workspaceId, runId) },
  );
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

const setStage = async (
  actor: RunActor,
  status: Extract<
    DocumentTranslationRunStatus,
    "preparing" | "translating" | "assembling" | "validating"
  >,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — lifecycle bookkeeping on the run audited at create.
    await tx
      .update(documentTranslationRuns)
      .set({ status })
      .where(eq(documentTranslationRuns.id, actor.runId));
  });
};

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

const translateWithDeepL = async (
  actor: RunActor,
  run: ClaimedRun,
  source: ArrayBuffer,
): Promise<Result<TranslationOutput, DocumentTranslationRunErrorCode>> => {
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
  const translated = await Result.tryPromise({
    try: async () =>
      await translateDocument({
        apiKey: await decryptContent(actor.organizationId, ciphertext, iv),
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
    return Result.err("translation_failed");
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
  for (
    let index = 0;
    index < segments.length;
    index += DOCUMENT_TRANSLATION_LIMITS.batchSize
  ) {
    const batch = segments.slice(
      index,
      index + DOCUMENT_TRANSLATION_LIMITS.batchSize,
    );
    const preceding = segments
      .slice(0, index)
      .slice(-DOCUMENT_TRANSLATION_LIMITS.contextUnits);
    // oxlint-disable-next-line no-await-in-loop -- batches are sequential so preceding translations provide context and metered spend stays bounded
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
      return Result.err("translation_failed");
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
    // oxlint-disable-next-line no-await-in-loop -- persist each completed batch before starting another model call
    await updateTranslatedUnits(actor, updates);
  }

  await setStage(actor, "assembling");
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
  const languages = {
    sourceLang: run.sourceLang,
    targetLang: run.targetLang,
  };
  const texts = units.map((unit) => unit.sourceText);
  const prepared = await Result.tryPromise({
    try: async () => {
      const [rows, glossary] = await Promise.all([
        decideDispositions(units, languages, context),
        proposeGlossary(
          detectGlossaryCandidates(texts),
          texts,
          languages,
          context,
        ),
      ]);
      return { rows, glossary };
    },
    catch: (cause) => cause,
  });
  if (Result.isError(prepared)) {
    return Result.err("provider_unavailable");
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
  for (
    let index = 0;
    index < pending.length;
    index += BILINGUAL_LIMITS.batchSize
  ) {
    const batch = pending.slice(index, index + BILINGUAL_LIMITS.batchSize);
    const first = batch.at(0);
    if (!first) {
      break;
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
    // oxlint-disable-next-line no-await-in-loop -- batches are sequential so preceding translations provide context and metered spend stays bounded
    const result = await Result.tryPromise({
      try: async () =>
        await translateBatch(
          { batch, preceding, glossary: prepared.value.glossary },
          languages,
          context,
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(result)) {
      return Result.err("translation_failed");
    }
    const updates: { unitKey: string; targetText: string }[] = [];
    for (const row of batch) {
      const targetText = result.value.get(row.ordinal);
      if (targetText === undefined) {
        return Result.err("translation_failed");
      }
      translated.set(row.rowId, targetText);
      updates.push({ unitKey: row.rowId, targetText });
    }
    // oxlint-disable-next-line no-await-in-loop -- persist each completed batch before starting another model call
    await updateTranslatedUnits(actor, updates);
  }

  await setStage(actor, "assembling");
  const operations = buildOperations(rows, translated);
  const applied = await Result.tryPromise({
    try: async () =>
      await applyFolioAIEditsToBuffer(conversion.value.buffer, operations, {
        author: "Stella",
        mode: "direct",
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(applied) || applied.value.skipped.length > 0) {
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
  await setStage(actor, "translating");

  let output: Result<TranslationOutput, DocumentTranslationRunErrorCode>;
  if (run.engine === DOCUMENT_TRANSLATION_ENGINE.DEEPL) {
    output = await translateWithDeepL(actor, run, loaded.value.buffer);
  } else {
    const context = await Result.tryPromise({
      try: async () => await createAIContext(actor, run),
      catch: (cause) => cause,
    });
    if (Result.isError(context)) {
      return "provider_unavailable";
    }
    if (run.output === DOCUMENT_TRANSLATION_OUTPUT.TRANSLATED) {
      output = await translateDocxWithAI(
        actor,
        run,
        loaded.value.buffer,
        context.value,
      );
    } else {
      output = await translateBilingualWithAI(
        actor,
        run,
        loaded.value.buffer,
        context.value,
      );
    }
  }
  if (Result.isError(output)) {
    return output.error;
  }

  await setStage(actor, "validating");
  if (output.value.mimeType === DOCX_MIME_TYPE) {
    const validation = await validateDocxBuffer(
      output.value.buffer instanceof Uint8Array
        ? copyToArrayBuffer(output.value.buffer)
        : output.value.buffer,
    );
    if (!validation.valid) {
      return "format_validation_failed";
    }
  }
  const scan = await scanFile({
    buffer:
      output.value.buffer instanceof Uint8Array
        ? output.value.buffer
        : new Uint8Array(output.value.buffer),
    declaredMimeType: output.value.mimeType,
    fileName: output.value.fileName,
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
    buffer: output.value.buffer,
    fileName: output.value.fileName,
    mimeType: output.value.mimeType,
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
          warnings: output.value.warnings,
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

export const reconcileStuckDocumentTranslationRuns =
  async (): Promise<number> => {
    const runningCutoff = new Date(Date.now() - STUCK_RUNNING_MS);
    const queuedCutoff = new Date(Date.now() - STUCK_QUEUED_MS);
    const recovered = await rootDb
      .update(documentTranslationRuns)
      .set({ status: "failed", errorCode: "internal", finishedAt: new Date() })
      .where(
        or(
          and(
            inArray(documentTranslationRuns.status, [
              "preparing",
              "translating",
              "assembling",
              "validating",
            ]),
            lt(documentTranslationRuns.startedAt, runningCutoff),
          ),
          and(
            eq(documentTranslationRuns.status, "queued"),
            lt(documentTranslationRuns.createdAt, queuedCutoff),
          ),
        ),
      )
      .returning({ id: documentTranslationRuns.id });
    return recovered.length;
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
  worker.on("error", (error) => {
    logger.error(
      "document_translation.worker_error",
      connectionErrorFields(error),
    );
  });

  const closeReconcile = startNonOverlappingInterval({
    intervalMs: ORPHAN_RECONCILE_INTERVAL_MS,
    run: async () => {
      await reconcileStuckDocumentTranslationRuns();
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
