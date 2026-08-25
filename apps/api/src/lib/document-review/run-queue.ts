/**
 * Background queue for durable document reviews.
 *
 * Reuses the BullMQ infrastructure that already backs the report-export and
 * file-derivative queues (no new queue system). A review draws several metered
 * model calls over a whole document and its references, which no synchronous
 * request survives, so it is a one-shot background job from day one.
 *
 * One-shot semantics: `attempts: 1`. A retry would re-run metered model calls;
 * instead ANY failure lands `status: "failed"` plus a closed-vocabulary
 * `errorCode` on the run row, which the read endpoint surfaces and the client
 * may retry deliberately by creating a new run.
 *
 * Convergence: the job id is derived from the run id, only a `queued` row is
 * claimable, and findings upsert on `(runId, positionId)`. A re-delivered job
 * is therefore either a no-op or writes exactly the rows it wrote before.
 */

import { panic, Result } from "better-result";
import { Worker } from "bullmq";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { rootDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  documentReviewFindings,
  documentReviewRuns,
  fields,
} from "@/api/db/schema";
import { isAiExtractablePropertyContent } from "@/api/db/schema-validators";
import type { FieldContent } from "@/api/db/schema-validators";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  buildDocumentReviewFindingRow,
  recountDocumentReviewFindingProgress,
  upsertDocumentReviewFindings,
} from "@/api/lib/document-review/finding-write";
import type { DocumentReviewFindingRow } from "@/api/lib/document-review/finding-write";
import { fetchAndPrepareReviewFiles } from "@/api/lib/document-review/prepare-review-files";
import type { ReviewFile } from "@/api/lib/document-review/prepare-review-files";
import { extractAskContents } from "@/api/lib/document-review/review-extract";
import type { ReviewAsk } from "@/api/lib/document-review/review-extract";
import { buildFindings } from "@/api/lib/document-review/review-grade";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
  DocumentReviewRunErrorCode,
} from "@/api/lib/document-review/run-contract";
import { finalizeReviewRun } from "@/api/lib/document-review/run-finalize";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import type { ReviewRunPlan } from "@/api/lib/document-review/run-plan";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedDocumentReviewRunId,
  brandPersistedUserId,
  brandValidatedWorkflowActorKey,
} from "@/api/lib/safe-id-boundaries";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";
import type { ResolvedTiers } from "@/api/lib/workflow/playbook-positions";
import {
  isTierStandard,
  resolveEffectiveAsk,
} from "@/api/lib/workflow/position-runtime";
import {
  loadClauseSnapshots,
  resolveTiers,
} from "@/api/lib/workflow/resolve-standards";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const QUEUE_NAME = "document-review-runs-v2";
const QUEUE_CONTRACT_VERSION = 2;
const JOB_NAME = "run-document-review";
const WORKER_CONCURRENCY = 2;
// One attempt: every pass runs metered model calls, so a BullMQ retry would
// double the spend. Failures are persisted on the row instead.
const JOB_ATTEMPTS = 1;
const REVIEW_TIMEOUT_MS = 120_000;
const SERVICE_TIER = "standard" as const;
const ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** A worker-executed `running` row this old lost its worker to a hard death. */
const STUCK_RUNNING_MS = 30 * 60 * 1000;
/** A table-executed `running` row is paced by the files-table property DAG, not
 *  by an owned job: a workspace-wide run walks every document, so it may
 *  legitimately stay open far longer than one review. This cutoff only has to
 *  outlast the workflow's own job timeouts. */
const STUCK_TABLE_RUNNING_MS = 6 * 60 * 60 * 1000;
/** A `queued` row this old lost its job to queue data loss; anything younger
 *  may simply be backlogged and must be left for the worker. */
const STUCK_QUEUED_MS = DAY_IN_MS;

type DocumentReviewRunJobDataV1 = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

type DocumentReviewRunJobDataV2 = DocumentReviewRunJobDataV1 & {
  contractVersion: typeof QUEUE_CONTRACT_VERSION;
};

type DocumentReviewRunWorkerJobData = DocumentReviewRunJobDataV1 & {
  contractVersion?: unknown;
};

export type EnqueueDocumentReviewRunArgs = {
  runId: SafeId<"documentReviewRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<DocumentReviewRunJobDataV2>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** One job, described exactly as the queue takes it. The run id IS the job
 *  identity: a duplicate enqueue collapses onto the job already in flight
 *  instead of scheduling a second execution. */
const runJob = ({
  runId,
  workspaceId,
  organizationId,
  userId,
}: EnqueueDocumentReviewRunArgs) => ({
  name: JOB_NAME,
  data: {
    contractVersion: QUEUE_CONTRACT_VERSION,
    runId,
    workspaceId,
    organizationId,
    userId,
  } satisfies DocumentReviewRunJobDataV2,
  opts: { jobId: createBullMqJobId(workspaceId, runId) },
});

export const enqueueDocumentReviewRun = async (
  args: EnqueueDocumentReviewRunArgs,
): Promise<void> => {
  const { name, data, opts } = runJob(args);
  await getQueue().add(name, data, opts);
};

/**
 * Enqueue a whole matter's reviews in one round trip. A files-table run opens a
 * run per document, so adding them one at a time would be one Redis round trip
 * per document for no gain; `addBulk` is the same jobs, same ids, one call.
 */
export const enqueueDocumentReviewRuns = async (
  runs: readonly EnqueueDocumentReviewRunArgs[],
): Promise<void> => {
  if (runs.length === 0) {
    return;
  }
  await getQueue().addBulk(runs.map(runJob));
};

/**
 * Janitor for runs orphaned by a hard worker death. A job-level failure
 * self-heals through the worker `failed` handler; a `kill -9` emits no event,
 * and the claim guard turns BullMQ's stalled re-delivery into a no-op, so the
 * row would sit `running` forever, and its document would stay blocked by the
 * one-active-run index. Cross-workspace by necessity, hence the RLS-exempt
 * root handle, exactly as the report-export reconciler does.
 *
 * The two states age at different rates: a `running` row is timed from the
 * claim that set `started_at`, a `queued` row from its creation, because a
 * queued job survives a restart and may simply be backlogged.
 */
export const reconcileStuckDocumentReviewRuns = async (): Promise<number> => {
  // Both cutoffs read the clock directly rather than deriving from an injected
  // `now`: a moving staleness boundary does not care about sub-millisecond
  // drift, and a literal clock read is what makes these comparisons provably
  // free of a database round-trip instead of asserting it in a comment.
  const runningCutoff = new Date(Date.now() - STUCK_RUNNING_MS);
  const tableRunningCutoff = new Date(Date.now() - STUCK_TABLE_RUNNING_MS);
  const queuedCutoff = new Date(Date.now() - STUCK_QUEUED_MS);
  // audit: skip — janitor bookkeeping on already-audited run rows; flips
  // abandoned runs to failed so the read endpoint surfaces them instead of
  // polling a stuck row forever.
  const recovered = await rootDb
    .update(documentReviewRuns)
    .set({ status: "failed", errorCode: "internal", finishedAt: new Date() })
    .where(
      or(
        and(
          eq(documentReviewRuns.status, "running"),
          eq(documentReviewRuns.executor, DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER),
          lt(documentReviewRuns.startedAt, runningCutoff),
        ),
        and(
          eq(documentReviewRuns.status, "running"),
          eq(documentReviewRuns.executor, DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE),
          lt(documentReviewRuns.startedAt, tableRunningCutoff),
        ),
        and(
          eq(documentReviewRuns.status, "queued"),
          lt(documentReviewRuns.createdAt, queuedCutoff),
        ),
      ),
    )
    .returning({ id: documentReviewRuns.id });
  return recovered.length;
};

export const initDocumentReviewRunWorker = () => {
  const worker = new Worker<DocumentReviewRunWorkerJobData>(
    QUEUE_NAME,
    async (job) => {
      if (job.data.contractVersion !== QUEUE_CONTRACT_VERSION) {
        panic("Document review v2 queue received a non-v2 job");
      }
      await processDocumentReviewRunJob(job.data);
    },
    {
      connection: createBullMqConnection(),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    // The job body already persists failures onto the row; this is the last
    // resort if the process itself threw before that could run.
    if (job) {
      markRunFailed(job.data, "internal").catch((markError: unknown) => {
        captureError(markError, {
          runId: job.data.runId,
          workspaceId: job.data.workspaceId,
        });
      });
    }
    const runId = job ? job.data.runId : "";
    const workspaceId = job ? job.data.workspaceId : "";
    captureError(error, { runId, workspaceId });
    logger.error("document_review_run.failed", {
      runId,
      "error.type": errorTag(error),
      queueName: QUEUE_NAME,
      workspaceId,
    });
  });

  worker.on("error", (error) => {
    logger.error("document_review_run.worker_error", {
      ...connectionErrorFields(error),
      queueName: QUEUE_NAME,
    });
  });

  const runReconcile = async (): Promise<void> => {
    const recovered = await reconcileStuckDocumentReviewRuns();
    if (recovered > 0) {
      logger.warn("document_review_run.recovered_stuck", {
        count: String(recovered),
      });
    }
  };
  const closeReconcile = startNonOverlappingInterval({
    intervalMs: ORPHAN_RECONCILE_INTERVAL_MS,
    run: runReconcile,
    onError: (error) => {
      captureError(error, { operation: "document_review_run.reconcile" });
    },
  });

  logger.info("document_review_run.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    close: async () => {
      await closeReconcile();
      await worker.close();
    },
  };
};

type RunActor = {
  scopedDb: ScopedDb;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  runId: SafeId<"documentReviewRun">;
};

const brandActor = (data: DocumentReviewRunJobDataV1): RunActor => {
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
    runId: brandPersistedDocumentReviewRunId(data.runId),
    scopedDb: createRootScopedDb(tenant),
    safeDb: createRootSafeDb(tenant),
  };
};

/** The run fields the worker executes from, read at claim time. */
type ClaimedRun = {
  basis: DocumentReviewRunBasis;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  contentSha256: string;
};

/**
 * Conditional `queued -> running` claim. The status predicate lives inside the
 * UPDATE, so two deliveries of the same job cannot both proceed: the loser
 * updates zero rows and returns nothing.
 */
const claimRun = async (actor: RunActor): Promise<ClaimedRun | null> => {
  const claimed = await actor.scopedDb(async (tx) => {
    // audit: skip — lifecycle bookkeeping on the run row audited at create.
    const rows = await tx
      .update(documentReviewRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(documentReviewRuns.id, actor.runId),
          eq(documentReviewRuns.workspaceId, actor.workspaceId),
          eq(documentReviewRuns.status, "queued"),
        ),
      )
      .returning({
        basis: documentReviewRuns.basis,
        entityId: documentReviewRuns.entityId,
        fileFieldId: documentReviewRuns.fileFieldId,
        entityVersionId: documentReviewRuns.entityVersionId,
        contentSha256: documentReviewRuns.contentSha256,
      });
    return rows.at(0);
  });
  return claimed ?? null;
};

const processDocumentReviewRunJob = async (
  data: DocumentReviewRunJobDataV1,
): Promise<void> => {
  const actor = brandActor(data);
  const claimed = await claimRun(actor);
  // A re-delivered job, an already-terminal run, or a deleted row: nothing to
  // do, and nothing to fail.
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

/** A pinned document, as recorded on the run. */
type PinnedDocument = {
  workspaceId: SafeId<"workspace">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  contentSha256: string;
};

type ResolvePinnedFilesResult =
  | { type: "resolved"; files: ReviewFile[] }
  | { type: "failed"; errorCode: DocumentReviewRunErrorCode };

/**
 * Resolve every pinned document back to the file it named, refusing anything
 * that has moved. `pdfFileId` is forced to null exactly as the interactive
 * path does: reference comparison and playbook citations both need folio block
 * identities, which the PDF preparation path does not carry.
 *
 * References pinned from other matters are read under a scope widened to
 * exactly the pinned matters, each pin held to the matter it was pinned in.
 */
const resolvePinnedFiles = async (
  actor: RunActor,
  pins: readonly PinnedDocument[],
): Promise<ResolvePinnedFilesResult> => {
  const pinnedWorkspaceIds = [...new Set(pins.map((pin) => pin.workspaceId))];
  const pinScopedDb = createRootScopedDb({
    organizationId: actor.organizationId,
    userId: actor.userId,
    workspaceIds: pinnedWorkspaceIds,
  });
  const rows = await pinScopedDb((tx) =>
    tx
      .select({
        id: fields.id,
        workspaceId: fields.workspaceId,
        entityVersionId: fields.entityVersionId,
        content: fields.content,
      })
      .from(fields)
      .where(
        and(
          inArray(fields.workspaceId, pinnedWorkspaceIds),
          inArray(
            fields.id,
            pins.map((pin) => pin.fileFieldId),
          ),
          inArray(
            fields.entityVersionId,
            pins.map((pin) => pin.entityVersionId),
          ),
        ),
      ),
  );

  const contentByPin = new Map<string, FieldContent>();
  for (const row of rows) {
    contentByPin.set(
      `${row.workspaceId}:${row.id}:${row.entityVersionId}`,
      row.content,
    );
  }

  const files: ReviewFile[] = [];
  for (const pin of pins) {
    const content = contentByPin.get(
      `${pin.workspaceId}:${pin.fileFieldId}:${pin.entityVersionId}`,
    );
    if (content?.type !== "file") {
      return { type: "failed", errorCode: "pin_unresolved" };
    }
    if (content.sha256Hex !== pin.contentSha256) {
      return { type: "failed", errorCode: "pin_content_changed" };
    }
    if (content.mimeType !== DOCX_MIME_TYPE) {
      return { type: "failed", errorCode: "unsupported_format" };
    }
    files.push({
      workspaceId: pin.workspaceId,
      fileFieldId: pin.fileFieldId,
      fileId: content.id,
      mimeType: content.mimeType,
      sha256Hex: content.sha256Hex,
      encrypted: content.encrypted,
      pdfFileId: null,
    });
  }
  return { type: "resolved", files };
};

/** Everything both passes need from the organization's AI configuration,
 *  resolved once per run. */
type PassDeps = {
  abortSignal: AbortSignal;
  entityVersionId: SafeId<"entityVersion">;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  promptCachingEnabled: boolean;
  serviceTier: typeof SERVICE_TIER;
  usageMetering: AIUsageMetering;
  workspaceId: SafeId<"workspace">;
};

/**
 * Execute one claimed run. Returns `null` on success, or the error code the
 * run failed with — the caller owns the terminal write so the failure path is
 * identical whether this returned or threw.
 */
const executeRun = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<DocumentReviewRunErrorCode | null> => {
  const plan = planReviewRun({
    basis: run.basis,
    executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
  });

  const references = run.basis.references;
  const pins: PinnedDocument[] = [
    {
      workspaceId: actor.workspaceId,
      fileFieldId: run.fileFieldId,
      entityVersionId: run.entityVersionId,
      contentSha256: run.contentSha256,
    },
    ...references.map((reference) => ({
      workspaceId: reference.workspaceId,
      fileFieldId: reference.fileFieldId,
      entityVersionId: reference.entityVersionId,
      contentSha256: reference.contentSha256,
    })),
  ];

  const resolved = await resolvePinnedFiles(actor, pins);
  if (resolved.type === "failed") {
    return resolved.errorCode;
  }

  const prepared = await fetchAndPrepareReviewFiles(
    resolved.files,
    actor.organizationId,
  );
  const preparedTarget = prepared.at(0);
  if (preparedTarget?.kind !== "docx") {
    return "unsupported_format";
  }
  const preparedReferences: PreparedDocxFile[] = [];
  for (const file of prepared.slice(1)) {
    if (file.kind !== "docx") {
      return "unsupported_format";
    }
    preparedReferences.push(file);
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

  const deps: PassDeps = {
    abortSignal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
    entityVersionId: run.entityVersionId,
    orgAIConfig: config.value.orgAIConfig,
    organizationId: actor.organizationId,
    promptCachingEnabled: config.value.promptCachingEnabled,
    serviceTier: SERVICE_TIER,
    usageMetering: {
      // Settles under the same action type the create-run pre-flight
      // estimates with, so the estimate and the ledger agree.
      actionType: "doc_review",
      organizationId: actor.organizationId,
      safeDb: actor.safeDb,
      serviceTier: SERVICE_TIER,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
    workspaceId: actor.workspaceId,
  };

  const gradingOutcome = await runGradingPass({
    actor,
    deps,
    plan,
    run,
    target: preparedTarget,
    targetFile: resolved.files.slice(0, 1),
  });
  await actor.scopedDb(
    async (tx) =>
      await recountDocumentReviewFindingProgress({
        tx,
        workspaceId: actor.workspaceId,
        runId: actor.runId,
      }),
  );
  if (gradingOutcome !== null) {
    return gradingOutcome;
  }

  return await finalizeRun(actor, run, plan);
};

/**
 * One pass over the run's positions.
 *
 * Extraction reads only the positions whose standard is an authored ladder: a
 * reference standard is compared against the document's own blocks and needs
 * no ASK. `buildFindings` then grades both kinds and returns one finding per
 * position, in the plan's order.
 */
const runGradingPass = async ({
  actor,
  deps,
  plan,
  run,
  target,
  targetFile,
}: {
  actor: RunActor;
  deps: PassDeps;
  plan: ReviewRunPlan;
  run: ClaimedRun;
  target: PreparedDocxFile;
  targetFile: ResolvedFile[];
}): Promise<DocumentReviewRunErrorCode | null> => {
  if (plan.positions.length === 0) {
    return null;
  }

  const positions = plan.positions.map((planned) => planned.position);
  const clauseSnapshots = await actor.scopedDb(
    async (tx) =>
      await loadClauseSnapshots(tx, actor.organizationId, positions),
  );
  const tiersBySourceId = new Map<string, ResolvedTiers>();
  const asks: ReviewAsk[] = [];
  for (const position of positions) {
    if (isTierStandard(position)) {
      tiersBySourceId.set(
        position.sourceId,
        resolveTiers(position, clauseSnapshots),
      );
    } else if (position.mode === "graded") {
      // A reference standard is graded against the document itself.
      continue;
    }
    const ask = resolveEffectiveAsk(position);
    const content = ask.content;
    // `planReviewRun` already excluded file-typed and empty asks; this narrows
    // the content union for the extractor rather than re-deciding eligibility.
    if (!isAiExtractablePropertyContent(content)) {
      continue;
    }
    asks.push({
      sourceId: position.sourceId,
      question: ask.question.trim(),
      content,
    });
  }

  const extraction = await extractAskContents({
    asks,
    resolvedFiles: targetFile,
    ...deps,
  });
  if (Result.isError(extraction)) {
    return "playbook_check_failed";
  }

  const graded: ReviewFinding[] = await buildFindings({
    positions,
    contentBySourceId: extraction.value.contentBySourceId,
    tiersBySourceId,
    target,
    perspective: run.basis.perspective,
    referenceEntityVersionIds: run.basis.references.map(
      (reference) => reference.entityVersionId,
    ),
    ...deps,
  });

  const plannedByPositionId = new Map(
    plan.positions.map((planned) => [planned.positionId, planned]),
  );
  const rows: FindingRow[] = [];
  for (const finding of graded) {
    const planned = plannedByPositionId.get(finding.positionId);
    if (planned === undefined) {
      continue;
    }
    rows.push(
      buildFindingRow({
        actor,
        run,
        positionId: planned.positionId,
        positionTitle: planned.title,
        payload: { finding },
      }),
    );
  }
  await upsertFindings(actor, rows);
  return null;
};

type FindingRow = DocumentReviewFindingRow;

const buildFindingRow = ({
  actor,
  run,
  positionId,
  positionTitle,
  payload,
}: {
  actor: RunActor;
  run: ClaimedRun;
  positionId: string;
  positionTitle: string;
  payload: DocumentReviewFindingPayload;
}): FindingRow =>
  buildDocumentReviewFindingRow({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    runId: actor.runId,
    entityId: run.entityId,
    fileFieldId: run.fileFieldId,
    entityVersionId: run.entityVersionId,
    positionId,
    positionTitle,
    payload,
  });

/** Commit the pass's findings and record how many the run holds, in the same
 *  transaction as the write, so the number can never run ahead of the rows. */
const upsertFindings = async (
  actor: RunActor,
  rows: readonly FindingRow[],
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    await upsertDocumentReviewFindings(tx, rows);
    // audit: skip — progress bookkeeping on the run row audited at create.
    await tx
      .update(documentReviewRuns)
      .set({
        completed: sql<number>`(
          select count(*)::int from ${documentReviewFindings}
          where ${documentReviewFindings.runId} = ${documentReviewRuns.id}
        )`,
      })
      .where(
        and(
          eq(documentReviewRuns.id, actor.runId),
          eq(documentReviewRuns.workspaceId, actor.workspaceId),
          eq(documentReviewRuns.status, "running"),
        ),
      );
  });
};

/**
 * Complete the run once the committed finding set is exactly the planned one.
 * A shortfall means the pass silently produced less than it promised, which is
 * an internal failure rather than a completed review.
 */
const finalizeRun = async (
  actor: RunActor,
  run: ClaimedRun,
  plan: ReviewRunPlan,
): Promise<DocumentReviewRunErrorCode | null> => {
  const finalized = await actor.scopedDb(
    async (tx) =>
      await finalizeReviewRun({
        tx,
        workspaceId: actor.workspaceId,
        runId: actor.runId,
        entityId: run.entityId,
        fileFieldId: run.fileFieldId,
        expectedFindingCount: plan.expectedFindingCount,
      }),
  );
  if (finalized.type === "incomplete") {
    return "internal";
  }
  if (finalized.carried > 0) {
    logger.info("document_review_run.decisions_carried", {
      count: String(finalized.carried),
      runId: actor.runId,
      workspaceId: actor.workspaceId,
    });
  }
  return null;
};

const setRunFailed = async (
  actor: RunActor,
  errorCode: DocumentReviewRunErrorCode,
): Promise<void> => {
  await actor.scopedDb(async (tx) => {
    // audit: skip — failure bookkeeping on the run row audited at create.
    await tx
      .update(documentReviewRuns)
      .set({ status: "failed", errorCode, finishedAt: new Date() })
      .where(
        and(
          eq(documentReviewRuns.id, actor.runId),
          eq(documentReviewRuns.workspaceId, actor.workspaceId),
          inArray(documentReviewRuns.status, ["queued", "running"]),
        ),
      );
  });
};

/** Last-resort failure marker used from the worker `failed` handler: rebrands
 *  the actor from raw job data. */
const markRunFailed = async (
  data: DocumentReviewRunJobDataV1,
  errorCode: DocumentReviewRunErrorCode,
): Promise<void> => {
  await setRunFailed(brandActor(data), errorCode);
};
