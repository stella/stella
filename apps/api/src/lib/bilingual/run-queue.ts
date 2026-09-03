/**
 * Durable bilingual translation runs.
 *
 * A run is created `queued` with its rows and glossary already confirmed by the
 * reviewer, handed to a BullMQ queue, and executed here: pending rows are
 * translated in batches, each batch is upserted as it lands (progress and
 * warnings are visible mid-run), and the filled document is written once as a
 * new version of the bilingual document at the end.
 *
 * One-shot semantics: `attempts: 1`. A retry would re-run metered model calls;
 * an abandoned run is flipped to `failed` by the reconciler instead.
 */

import { Result } from "better-result";
import { Worker } from "bullmq";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { applyFolioAIEditsToBuffer } from "@stll/folio-core/server";
import { DAY_IN_MS } from "@stll/time";

import { rootDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  bilingualTranslationRows,
  bilingualTranslationRuns,
} from "@/api/db/schema";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { translateBatch } from "@/api/lib/bilingual/ai";
import type {
  BilingualAIDocumentContext,
  TranslationContextRow,
} from "@/api/lib/bilingual/ai";
import {
  BILINGUAL_LIMITS,
  BILINGUAL_ROW_DISPOSITION,
} from "@/api/lib/bilingual/contract";
import type {
  BilingualGlossaryEntry,
  BilingualRunErrorCode,
} from "@/api/lib/bilingual/contract";
import { buildOperations } from "@/api/lib/bilingual/operations";
import type { StoredRow } from "@/api/lib/bilingual/operations";
import { checkTranslationConsistency } from "@/api/lib/bilingual/rows";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  QUEUE_REQUEUE_OUTCOME,
  requeueDeterministicJob,
} from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-docx-buffer";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { errorTag } from "@/api/lib/errors/utils";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  scanPendingRows,
} from "@/api/lib/queue-reconcile-scan";
import type { ReconcileScanResult } from "@/api/lib/queue-reconcile-scan";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedBilingualTranslationRunId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "bilingual-translation-runs";
const JOB_NAME = "run-bilingual-translation";
const WORKER_CONCURRENCY = 2;
const JOB_ATTEMPTS = 1;
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const SERVICE_TIER = "standard" as const;
const ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_RUNNING_MS = 60 * 60 * 1000;
const STUCK_QUEUED_MS = DAY_IN_MS;

type BilingualRunJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

export type EnqueueBilingualRunArgs = {
  runId: SafeId<"bilingualTranslationRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<BilingualRunJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** One job, described exactly as the queue takes it. The run id IS the job
 *  identity: a duplicate enqueue collapses onto the job already in flight
 *  instead of scheduling a second metered execution. */
const runJob = ({
  runId,
  workspaceId,
  organizationId,
  userId,
}: EnqueueBilingualRunArgs) => ({
  name: JOB_NAME,
  data: { runId, workspaceId, organizationId, userId },
  opts: { jobId: createBullMqJobId(workspaceId, runId) },
});

export const enqueueBilingualRun = async (
  args: EnqueueBilingualRunArgs,
): Promise<void> => {
  const { data, name, opts } = runJob(args);
  await getQueue().add(name, data, opts);
};

/** Flip abandoned runs to `failed` so the read endpoint stops reporting them
 *  as in flight. */
export const reconcileStuckBilingualRuns = async (): Promise<number> => {
  const runningCutoff = new Date(Date.now() - STUCK_RUNNING_MS);
  const queuedCutoff = new Date(Date.now() - STUCK_QUEUED_MS);
  // audit: skip — janitor bookkeeping on already-audited run rows.
  const recovered = await rootDb
    .update(bilingualTranslationRuns)
    .set({ status: "failed", errorCode: "internal", finishedAt: new Date() })
    .where(
      or(
        and(
          eq(bilingualTranslationRuns.status, "running"),
          lt(bilingualTranslationRuns.startedAt, runningCutoff),
        ),
        and(
          eq(bilingualTranslationRuns.status, "queued"),
          lt(bilingualTranslationRuns.createdAt, queuedCutoff),
        ),
      ),
    )
    .returning({ id: bilingualTranslationRuns.id });
  return recovered.length;
};

/** The (timestamp, id) keyset this sweep's walk pages on. */
const bilingualRunCursorCodec = createTimestampIdCursorCodec({
  column: bilingualTranslationRuns.createdAt,
  brandId: brandPersistedBilingualTranslationRunId,
});

type QueuedBilingualRunRow = {
  createdCursor: string;
  id: SafeId<"bilingualTranslationRun">;
  organizationId: SafeId<"organization">;
  requestedBy: string | null;
  workspaceId: SafeId<"workspace">;
};

type ReconcileQueuedBilingualRunsOptions = {
  db?: Pick<typeof rootDb, "select">;
  queue?: RequeueableQueue<BilingualRunJobData>;
};

type ReconcileQueuedBilingualRunsResult = ReconcileScanResult & {
  /**
   * `requested_by` is nulled when the requester's account is deleted, and the
   * job carries an actor. Counted rather than dropped quietly; the staleness
   * janitor above fails those rows once they age out.
   */
  unattributed: number;
};

/**
 * Hand `queued` runs back to the queue when nothing owns them anymore.
 *
 * The run row commits before its job is added, so a crash in between — or a
 * queue that lost its waiting jobs — leaves a run no worker will ever pick up,
 * and the row alone cannot tell that apart from a run still waiting its turn.
 * Repeating the enqueue is safe: the job id is derived from the run id and
 * only a `queued` row is claimable, so a duplicate delivery is a no-op rather
 * than a second metered execution.
 *
 * The walk pages forward on a keyset cursor rather than re-reading one fixed
 * page: a run the queue still owns keeps its `queued` row, so a sweep bounded
 * by the first page would inspect the same healthy backlog every tick and
 * never reach the orphan behind it.
 */
export const reconcileQueuedBilingualRuns = async ({
  db = rootDb,
  queue = getQueue(),
}: ReconcileQueuedBilingualRunsOptions = {}): Promise<ReconcileQueuedBilingualRunsResult> => {
  let unattributed = 0;

  const after = (cursor: QueuedBilingualRunRow | null) => {
    if (cursor === null) {
      return undefined;
    }
    return bilingualRunCursorCodec.keysetAfter({
      cursor: {
        timestamp: reconcileCursorTimestamp(cursor.createdCursor),
        id: cursor.id,
      },
      idColumn: bilingualTranslationRuns.id,
      direction: "ascending",
    });
  };

  const readPage = async (cursor: QueuedBilingualRunRow | null) =>
    await db
      .select({
        createdCursor: bilingualRunCursorCodec.cursorValue,
        id: bilingualTranslationRuns.id,
        organizationId: bilingualTranslationRuns.organizationId,
        requestedBy: bilingualTranslationRuns.requestedBy,
        workspaceId: bilingualTranslationRuns.workspaceId,
      })
      .from(bilingualTranslationRuns)
      .where(and(eq(bilingualTranslationRuns.status, "queued"), after(cursor)))
      .orderBy(
        asc(bilingualTranslationRuns.createdAt),
        asc(bilingualTranslationRuns.id),
      )
      .limit(RECONCILE_SCAN_PAGE_SIZE);

  const handle = async (run: QueuedBilingualRunRow): Promise<boolean> => {
    if (run.requestedBy === null) {
      unattributed += 1;
      return false;
    }
    const { data, name, opts } = runJob({
      organizationId: run.organizationId,
      runId: run.id,
      userId: brandPersistedUserId(run.requestedBy),
      workspaceId: run.workspaceId,
    });
    const outcome = await Result.tryPromise({
      try: async () =>
        await requeueDeterministicJob({ data, jobId: opts.jobId, name, queue }),
      catch: (cause) => cause,
    });
    if (Result.isError(outcome)) {
      captureError(outcome.error, { runId: run.id });
      return false;
    }
    return outcome.value === QUEUE_REQUEUE_OUTCOME.REQUEUED;
  };

  const scan = await scanPendingRows({ handle, readPage });
  return { ...scan, unattributed };
};

export const initBilingualRunWorker = () => {
  const worker = new Worker<BilingualRunJobData>(
    QUEUE_NAME,
    async (job) => {
      await processBilingualRunJob(job.data);
    },
    { connection: createBullMqConnection(), concurrency: WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, error) => {
    if (job) {
      setRunFailed(brandActor(job.data), "internal").catch(
        (markError: unknown) => {
          captureError(markError, {
            runId: job.data.runId,
            workspaceId: job.data.workspaceId,
          });
        },
      );
    }
    const runId = job ? job.data.runId : "";
    const workspaceId = job ? job.data.workspaceId : "";
    captureError(error, { runId, workspaceId });
    logger.error("bilingual_run.failed", {
      runId,
      "error.type": errorTag(error),
      workspaceId,
    });
  });

  worker.on(
    "error",
    createQueueWorkerErrorLogger("bilingual_run.worker_error"),
  );

  const closeReconcile = startNonOverlappingInterval({
    intervalMs: ORPHAN_RECONCILE_INTERVAL_MS,
    run: async () => {
      const recovered = await reconcileStuckBilingualRuns();
      if (recovered > 0) {
        logger.warn("bilingual_run.recovered_stuck", {
          count: String(recovered),
        });
      }
    },
    onError: (error) => {
      captureError(error, { operation: "bilingual_run.reconcile" });
    },
  });

  logger.info("bilingual_run.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    close: async () => {
      await closeReconcile();
      await worker.close();
    },
  };
};

// ----------------------------------------------------------------------------
// Execution
// ----------------------------------------------------------------------------

type RunActor = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  runId: SafeId<"bilingualTranslationRun">;
};

const brandActor = (data: BilingualRunJobData): RunActor => {
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
    runId: brandPersistedBilingualTranslationRunId(data.runId),
    scopedDb: createRootScopedDb(tenant),
    safeDb: createRootSafeDb(tenant),
  };
};

type ClaimedRun = {
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  sourceLang: string;
  targetLang: string;
  glossary: BilingualGlossaryEntry[];
};

/** Conditional `queued -> running` claim; a second delivery updates zero rows. */
const claimRun = async (actor: RunActor): Promise<ClaimedRun | null> => {
  const claimed = await actor.scopedDb(async (tx) => {
    // audit: skip — lifecycle bookkeeping on the run row audited at create.
    const rows = await tx
      .update(bilingualTranslationRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(bilingualTranslationRuns.id, actor.runId),
          eq(bilingualTranslationRuns.workspaceId, actor.workspaceId),
          eq(bilingualTranslationRuns.status, "queued"),
        ),
      )
      .returning({
        entityId: bilingualTranslationRuns.entityId,
        fileFieldId: bilingualTranslationRuns.fileFieldId,
        entityVersionId: bilingualTranslationRuns.entityVersionId,
        sourceLang: bilingualTranslationRuns.sourceLang,
        targetLang: bilingualTranslationRuns.targetLang,
        glossary: bilingualTranslationRuns.glossary,
      });
    return rows.at(0);
  });
  return claimed ?? null;
};

const processBilingualRunJob = async (
  data: BilingualRunJobData,
): Promise<void> => {
  const actor = brandActor(data);
  const claimed = await claimRun(actor);
  if (claimed === null) {
    return;
  }
  const outcome = await Result.tryPromise({
    try: async () => await executeRun(actor, claimed),
    catch: (cause) => cause,
  });
  if (Result.isError(outcome)) {
    captureError(outcome.error, {
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    await setRunFailed(actor, "internal");
    return;
  }
  if (outcome.value !== null) {
    await setRunFailed(actor, outcome.value);
  }
};

const loadRows = async (actor: RunActor): Promise<StoredRow[]> => {
  const rows = await actor.safeDb((tx) =>
    tx
      .select({
        rowId: bilingualTranslationRows.rowId,
        ordinal: bilingualTranslationRows.ordinal,
        kind: bilingualTranslationRows.kind,
        inTable: bilingualTranslationRows.inTable,
        tableLayout: bilingualTranslationRows.tableLayout,
        sourceParaId: bilingualTranslationRows.sourceParaId,
        sourceText: bilingualTranslationRows.sourceText,
        disposition: bilingualTranslationRows.disposition,
        targetText: bilingualTranslationRows.targetText,
        status: bilingualTranslationRows.status,
      })
      .from(bilingualTranslationRows)
      .where(eq(bilingualTranslationRows.runId, actor.runId))
      .orderBy(asc(bilingualTranslationRows.ordinal))
      .limit(BILINGUAL_LIMITS.rowsMax),
  );
  if (Result.isError(rows)) {
    throw rows.error;
  }
  return rows.value;
};

const needsTranslation = (row: StoredRow): boolean =>
  row.disposition !== BILINGUAL_ROW_DISPOSITION.KEEP;

const executeRun = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<BilingualRunErrorCode | null> => {
  const loaded = await loadEntityVersionDocxBuffer({
    safeDb: actor.safeDb,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    entityId: run.entityId,
    fileFieldId: run.fileFieldId,
  });
  if (Result.isError(loaded)) {
    return "document_unresolved";
  }
  if (loaded.value.entityVersionId !== run.entityVersionId) {
    return "document_changed";
  }

  const config = await Result.tryPromise({
    try: async () => ({
      orgAIConfig: await loadOrgAIConfig(actor.organizationId),
      promptCachingEnabled: await loadPromptCachingPreference(
        actor.organizationId,
      ),
    }),
    catch: (cause) => cause,
  });
  if (Result.isError(config)) {
    captureError(config.error, {
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    return "ai_unavailable";
  }

  const rows = await loadRows(actor);
  const context: BilingualAIDocumentContext = {
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    orgAIConfig: config.value.orgAIConfig,
    promptCachingEnabled: config.value.promptCachingEnabled,
    abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    scopeKey: run.entityVersionId,
    sourceDocument: rows,
    usageMetering: {
      actionType: "doc_review",
      organizationId: actor.organizationId,
      safeDb: actor.safeDb,
      serviceTier: SERVICE_TIER,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
  };

  const languages = { sourceLang: run.sourceLang, targetLang: run.targetLang };
  const translated = new Map<string, string>(
    rows.flatMap((row) =>
      row.targetText === null ? [] : [[row.rowId, row.targetText]],
    ),
  );

  const pending = rows.filter(
    (row) => needsTranslation(row) && row.status === "pending",
  );
  // Batches run strictly one after another: each carries the previous rows'
  // translations as context, and one request in flight per run keeps the
  // metered spend predictable.
  const translateFrom = async (
    index: number,
  ): Promise<BilingualRunErrorCode | null> => {
    const batch = pending.slice(index, index + BILINGUAL_LIMITS.batchSize);
    const first = batch[0];
    if (!first) {
      return null;
    }
    const preceding: TranslationContextRow[] = rows
      .filter((row) => row.ordinal < first.ordinal && needsTranslation(row))
      .slice(-BILINGUAL_LIMITS.contextRows)
      .map((row) => ({
        sourceText: row.sourceText,
        targetText: translated.get(row.rowId) ?? null,
      }));

    const result = await Result.tryPromise({
      try: async () =>
        await translateBatch(
          { batch, preceding, glossary: run.glossary },
          languages,
          context,
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(result)) {
      captureError(result.error, {
        runId: actor.runId,
        workspaceId: actor.workspaceId,
      });
      return "translation_failed";
    }

    const updates = batch.map((row) => {
      const text = result.value.get(row.ordinal);
      if (text === undefined) {
        return {
          rowId: row.rowId,
          status: "failed" as const,
          targetText: null,
          warnings: ["No translation returned"],
        };
      }
      translated.set(row.rowId, text);
      return {
        rowId: row.rowId,
        status: "translated" as const,
        targetText: text,
        warnings: checkTranslationConsistency({
          sourceText: row.sourceText,
          targetText: text,
          glossary: run.glossary,
        }),
      };
    });
    await actor.scopedDb(async (tx) => {
      // audit: skip — row bookkeeping inside a run audited at create.
      // One statement for the whole batch: a VALUES list joined on row_id.
      const values = sql.join(
        updates.map(
          (update) =>
            sql`(${update.rowId}, ${update.status}, ${update.targetText}, ${JSON.stringify(update.warnings)}::text::jsonb)`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        UPDATE ${bilingualTranslationRows} AS r
        SET status = v.status,
            target_text = v.target_text,
            warnings = v.warnings,
            updated_at = now()
        FROM (VALUES ${values}) AS v(row_id, status, target_text, warnings)
        WHERE r.run_id = ${actor.runId}
          AND r.workspace_id = ${actor.workspaceId}
          AND r.row_id = v.row_id
      `);
      await tx
        .update(bilingualTranslationRuns)
        .set({
          completed: sql`LEAST(${bilingualTranslationRuns.total}, ${bilingualTranslationRuns.completed} + ${batch.length})`,
        })
        .where(eq(bilingualTranslationRuns.id, actor.runId));
    });
    return await translateFrom(index + BILINGUAL_LIMITS.batchSize);
  };
  const translationOutcome = await translateFrom(0);
  if (translationOutcome !== null) {
    return translationOutcome;
  }
  // Rows the model skipped are stored as failed and left as the source copy.
  // No translated row at all means there is nothing to write: fail the run
  // rather than publish an untouched version as "completed".
  const translatedCount = rows.filter(
    (row) => needsTranslation(row) && translated.has(row.rowId),
  ).length;
  if (translatedCount === 0) {
    return "translation_failed";
  }

  const operations = buildOperations(rows, translated);
  const applied = await Result.tryPromise({
    try: async () =>
      await applyFolioAIEditsToBuffer(loaded.value.buffer, operations, {
        author: "Stella",
        mode: "direct",
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(applied)) {
    captureError(applied.error, {
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    return "apply_failed";
  }
  if (applied.value.skipped.length > 0) {
    logger.warn("bilingual_run.operations_skipped", {
      count: String(applied.value.skipped.length),
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
  }

  const validation = await validateDocxBuffer(applied.value.buffer);
  if (!validation.valid) {
    captureError(new Error(validation.error), {
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    return "apply_failed";
  }
  const scanResult = await scanFile({
    buffer: new Uint8Array(applied.value.buffer),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: loaded.value.fileName,
  });
  if (Result.isError(scanResult) || scanResult.value.verdict === "reject") {
    return "apply_failed";
  }

  const written = await createEntityVersionFromBuffer({
    safeDb: actor.safeDb,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    entityId: run.entityId,
    userId: actor.userId,
    recordAuditEvent: createAuditRecorder({
      execution: {
        performer: {
          type: "service",
          id: `bilingual-run:${actor.runId}`,
          name: "Bilingual translation",
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
      request: new Request("http://bilingual-run.internal/"),
      server: null,
    }),
    buffer: applied.value.buffer,
    fileName: loaded.value.fileName,
    mimeType: DOCX_MIME_TYPE,
    source: null,
    writePolicy: {
      type: "automatic-docx-edit",
      expectedCurrentVersionId: run.entityVersionId,
      filePropertyId: loaded.value.filePropertyId,
      replacedFileFieldId: run.fileFieldId,
    },
    scanWarnings: getScanWarnings(scanResult.value) ?? undefined,
  });
  if (Result.isError(written)) {
    captureError(written.error, {
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
    return "apply_failed";
  }

  await actor.scopedDb(async (tx) => {
    // audit: skip — completion bookkeeping on the run row audited at create.
    await tx
      .update(bilingualTranslationRuns)
      .set({
        status: "completed",
        finishedAt: new Date(),
        outputEntityVersionId: written.value.entityVersionId,
      })
      .where(eq(bilingualTranslationRuns.id, actor.runId));
  });
  return null;
};

const setRunFailed = async (
  actor: RunActor,
  errorCode: BilingualRunErrorCode,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — failure bookkeeping on the run row audited at create.
    await tx
      .update(bilingualTranslationRuns)
      .set({ status: "failed", errorCode, finishedAt: new Date() })
      .where(
        and(
          eq(bilingualTranslationRuns.id, actor.runId),
          eq(bilingualTranslationRuns.workspaceId, actor.workspaceId),
          inArray(bilingualTranslationRuns.status, ["queued", "running"]),
        ),
      );
  });
};
