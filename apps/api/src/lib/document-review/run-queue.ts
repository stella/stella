import { Result } from "better-result";
/**
 * Durable document reviews on the document run queue
 * (`@/api/lib/queue/document-run-queue`), which owns the one-shot skeleton:
 * one attempt, the run id as the job id, the time budget and the stuck rules.
 * A review draws several metered model calls over a whole document and its
 * references, which no synchronous request survives. This module keeps what
 * is the review's own: its table's reads and transitions, and the review.
 *
 * Convergence: only a `queued` row is claimable, and findings upsert on
 * `(runId, positionId)`. A re-delivered job is therefore either a no-op or
 * writes exactly the rows it wrote before.
 */
import { and, asc, eq, lt, or, sql } from "drizzle-orm";

import type { rootDb, Transaction } from "@/api/db/root";
import { documentReviewRuns } from "@/api/db/schema";
import { isAiExtractablePropertyContent } from "@/api/db/schema-validators";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import {
  buildDocumentReviewFindingRow,
  recountDocumentReviewFindingProgress,
  writeReviewFindingBatch,
} from "@/api/lib/document-review/finding-write";
import type { DocumentReviewFindingRow } from "@/api/lib/document-review/finding-write";
import { fetchAndPrepareReviewFiles } from "@/api/lib/document-review/prepare-review-files";
import { REFERENCE_GRADE_TASK } from "@/api/lib/document-review/reference-grade";
import { referencePassageIds } from "@/api/lib/document-review/reference-passages";
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
import {
  failReviewRun,
  finalizeWorkerRun,
  recordRunWithheldSources,
  reportFinalizedReviewRun,
} from "@/api/lib/document-review/run-finalize";
import { resolveDocumentReviewRunInputs } from "@/api/lib/document-review/run-inputs";
import type { PinnedDocument } from "@/api/lib/document-review/run-inputs";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import type { ReviewRunPlan } from "@/api/lib/document-review/run-plan";
import { DocumentTooLargeError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import {
  createDocumentRunQueue,
  STANDARD_DOCUMENT_RUN_LIMITS,
} from "@/api/lib/queue/document-run-queue";
import type {
  DocumentRunJobData,
  EnqueueDocumentRunArgs,
  StuckRunAges,
} from "@/api/lib/queue/document-run-queue";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
} from "@/api/lib/queue/reconcile-scan";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedDocumentReviewRunId } from "@/api/lib/safe-id-boundaries";
import {
  formatModelRef,
  getTanStackTextModelInfoForTask,
} from "@/api/lib/tanstack-ai-models";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";
import type { ResolvedTiers } from "@/api/lib/workflow/playbook-positions";
import {
  answerShapeForPosition,
  isTierStandard,
  resolveEffectiveAsk,
} from "@/api/lib/workflow/position-runtime";
import {
  fitDocxFilesToRequestBudget,
  requestBudgetBytesForTask,
} from "@/api/lib/workflow/request-budget";
import {
  loadClauseSnapshots,
  resolveTiers,
} from "@/api/lib/workflow/resolve-standards";

/** The queue's job shape version; the worker refuses a job of any other. */
const QUEUE_CONTRACT_VERSION = 2;
const SERVICE_TIER = "standard" as const;
/** A table-executed `running` row is paced by the files-table property DAG, not
 *  by an owned job: a workspace-wide run walks every document, so it may
 *  legitimately stay open far longer than one review. This cutoff only has to
 *  outlast the workflow's own job timeouts. */
const STUCK_TABLE_RUNNING_MS = 6 * 60 * 60 * 1000;

type ReconcileDb = Pick<typeof rootDb, "select" | "update">;

/**
 * Fail the runs a hard worker death or a lost job left behind, in one
 * statement: the row would otherwise sit active forever, and its document
 * would stay blocked by the one-active-run index. Cross-workspace by
 * necessity, hence the RLS-exempt root handle.
 *
 * The two states age at different rates: a `running` row is timed from the
 * claim that set `started_at`, a `queued` row from its creation, because a
 * queued job survives a restart and may simply be backlogged. A table-executed
 * run is paced by the files-table workflow and gets its own, longer cutoff.
 */
const failStuckRuns = async ({
  db,
  stuck,
}: {
  db: ReconcileDb;
  stuck: StuckRunAges;
}): Promise<number> => {
  // The cutoffs are resolved in the database, against its own clock, so no
  // timestamp round-trips through a millisecond JS Date.
  const runningCutoff = sql`now() - ${`${stuck.runningMs} milliseconds`}::interval`;
  const tableRunningCutoff = sql`now() - ${`${STUCK_TABLE_RUNNING_MS} milliseconds`}::interval`;
  const queuedCutoff = sql`now() - ${`${stuck.queuedMs} milliseconds`}::interval`;
  // audit: skip — janitor bookkeeping on already-audited run rows; flips
  // abandoned runs to failed so the read endpoint surfaces them instead of
  // polling a stuck row forever.
  const recovered = await db
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

/** The (timestamp, id) keyset this sweep's walk pages on. */
const reviewRunCursorCodec = createTimestampIdCursorCodec({
  column: documentReviewRuns.createdAt,
  brandId: brandPersistedDocumentReviewRunId,
});

type QueuedReviewRunRow = {
  createdCursor: string;
  id: SafeId<"documentReviewRun">;
  organizationId: SafeId<"organization">;
  requestedBy: string | null;
  workspaceId: SafeId<"workspace">;
};

/**
 * The next page of `queued` runs the queued sweep may hand back. The walk
 * pages forward on a keyset cursor rather than re-reading one fixed page: a
 * run the queue still owns keeps its `queued` row, so a sweep bounded by the
 * first page would inspect the same healthy backlog every tick and never
 * reach the orphan behind it.
 *
 * Table-executed runs are excluded: they are paced by the files-table property
 * DAG and were never handed to this queue.
 */
const readQueuedPage = async (
  db: ReconcileDb,
  cursor: QueuedReviewRunRow | null,
) =>
  await db
    .select({
      createdCursor: reviewRunCursorCodec.cursorValue,
      id: documentReviewRuns.id,
      organizationId: documentReviewRuns.organizationId,
      requestedBy: documentReviewRuns.requestedBy,
      workspaceId: documentReviewRuns.workspaceId,
    })
    .from(documentReviewRuns)
    .where(
      and(
        eq(documentReviewRuns.status, "queued"),
        eq(documentReviewRuns.executor, DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER),
        cursor === null
          ? undefined
          : reviewRunCursorCodec.keysetAfter({
              cursor: {
                timestamp: reconcileCursorTimestamp(cursor.createdCursor),
                id: cursor.id,
              },
              idColumn: documentReviewRuns.id,
              direction: "ascending",
            }),
      ),
    )
    .orderBy(asc(documentReviewRuns.createdAt), asc(documentReviewRuns.id))
    .limit(RECONCILE_SCAN_PAGE_SIZE);

type DocumentReviewRunActor = RootRunActor<"documentReviewRun">;
type RunActor = DocumentReviewRunActor;

const brandActor = (data: DocumentRunJobData): RunActor =>
  createRootRunActor(data, brandPersistedDocumentReviewRunId);

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
  const claimed = await actor.writeDb(async (tx) => {
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

type RecordRunModelArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  modelRef: string;
};

/**
 * Stamp the model the run grades with, once grading resolves it. A run is
 * reproducible only against the model that produced its findings, and a claim
 * happens before the model is known, so this is its own write.
 */
export const recordDocumentReviewRunModel = async ({
  tx,
  workspaceId,
  runId,
  modelRef,
}: RecordRunModelArgs): Promise<void> => {
  // audit: skip — lifecycle bookkeeping on the run row audited at create.
  await tx
    .update(documentReviewRuns)
    .set({ modelRef })
    .where(
      and(
        eq(documentReviewRuns.id, runId),
        eq(documentReviewRuns.workspaceId, workspaceId),
      ),
    );
};

/** Everything both passes need from the organization's AI configuration,
 *  resolved once per run. */
type PassDeps = {
  abortSignal: AbortSignal;
  admission: ModelDispatchAdmission;
  entityVersionId: SafeId<"entityVersion">;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
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
const executeRun = async ({
  actor,
  admission,
  run,
  deadline,
}: {
  actor: RunActor;
  admission: ModelDispatchAdmission;
  run: ClaimedRun;
  deadline: () => AbortSignal;
}): Promise<DocumentReviewRunErrorCode | null> => {
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

  const resolved = await resolveDocumentReviewRunInputs(actor.inputDb, {
    pins,
    passageIds: referencePassageIds(
      plan.positions.map((planned) => planned.position),
    ),
  });
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

  const configResult = await Result.tryPromise({
    try: async () => {
      const settings = await actor.writeDb(
        async (tx) => await loadOrgAISettings(tx, actor),
      );
      if (Result.isError(settings)) {
        return Result.err(settings.error);
      }
      const { orgAIConfig, managedAIResidency, promptCachingEnabled } =
        settings.value;
      return Result.ok({
        orgAIConfig,
        managedAIResidency,
        // Resolved here, where a role without a provider is already an
        // `ai_unavailable` run rather than a failure mid-grading.
        graderModel: getTanStackTextModelInfoForTask(
          REFERENCE_GRADE_TASK,
          orgAIConfig,
          {
            dataClass: "customer",
            organizationId: actor.organizationId,
            modelTier: admission.modelTier,
          },
        ),
        promptCachingEnabled,
      });
    },
    catch: (cause) => cause,
  });
  const config = Result.flatten(configResult);
  if (Result.isError(config)) {
    captureError(
      config.error,
      handlerErrorContext("documentreview.executeRun.config_error", {
        runId: actor.runId,
        workspaceId: actor.workspaceId,
      }),
    );
    return "ai_unavailable";
  }

  await actor.writeDb(
    async (tx) =>
      await recordDocumentReviewRunModel({
        tx,
        workspaceId: actor.workspaceId,
        runId: actor.runId,
        modelRef: formatModelRef(config.value.graderModel),
      }),
  );

  const deps: PassDeps = {
    abortSignal: deadline(),
    admission,
    entityVersionId: run.entityVersionId,
    orgAIConfig: config.value.orgAIConfig,
    managedAIResidency: config.value.managedAIResidency,
    organizationId: actor.organizationId,
    promptCachingEnabled: config.value.promptCachingEnabled,
    serviceTier: SERVICE_TIER,
    usageMetering: {
      // Settles under the same action type the create-run pre-flight
      // estimates with, so the estimate and the ledger agree.
      actionType: "doc_review",
      organizationId: actor.organizationId,
      safeDb: actor.writeSafeDb,
      serviceTier: SERVICE_TIER,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
    workspaceId: actor.workspaceId,
  };

  const gradingOutcome = await runGradingPass({
    actor,
    passageTextById: resolved.passageTextById,
    deps,
    plan,
    run,
    target: preparedTarget,
    targetFile: resolved.files.slice(0, 1),
  });
  await actor.writeDb(
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
 *
 * Grading is several model calls, so its findings are committed as each call
 * returns rather than in one write at the end: `document_review_runs.completed`
 * is what the review surface polls, and a review that reports nothing until it
 * is finished is a review that looks stuck.
 */
const runGradingPass = async ({
  actor,
  passageTextById,
  deps,
  plan,
  run,
  target,
  targetFile,
}: {
  actor: RunActor;
  passageTextById: ReadonlyMap<string, string>;
  deps: PassDeps;
  plan: ReviewRunPlan;
  run: ClaimedRun;
  target: PreparedDocxFile;
  targetFile: ResolvedFile[];
}): Promise<DocumentReviewRunErrorCode | null> => {
  if (plan.positions.length === 0) {
    return null;
  }

  const fit = fitDocxFilesToRequestBudget({
    files: [target],
    budgetBytes: requestBudgetBytesForTask("pdf", deps.orgAIConfig, {
      dataClass: "customer",
      organizationId: actor.organizationId,
      modelTier: deps.admission.modelTier,
    }),
  });
  if (Result.isError(fit)) {
    return "document_too_large";
  }
  if (fit.value.type === "cut") {
    const { withheld } = fit.value;
    await actor.writeDb(
      async (tx) =>
        await recordRunWithheldSources(
          tx,
          { workspaceId: actor.workspaceId, runId: actor.runId },
          withheld,
        ),
    );
  }

  const positions = plan.positions.map((planned) => planned.position);
  const clauseSnapshots = await actor.writeDb(
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
      answerShape: answerShapeForPosition(position),
    });
  }

  const extraction = await extractAskContents({
    asks,
    resolvedFiles: targetFile,
    ...deps,
  });
  if (Result.isError(extraction)) {
    return DocumentTooLargeError.is(extraction.error)
      ? "document_too_large"
      : "playbook_check_failed";
  }

  const plannedByPositionId = new Map(
    plan.positions.map((planned) => [planned.positionId, planned]),
  );
  const toRows = (findings: readonly ReviewFinding[]): FindingRow[] => {
    const rows: FindingRow[] = [];
    for (const finding of findings) {
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
    return rows;
  };

  const graded: ReviewFinding[] = await buildFindings({
    positions,
    passageTextById,
    askOutcomes: extraction.value.outcomeBySourceId,
    tiersBySourceId,
    target,
    documentRead: fit.value.type,
    perspective: run.basis.perspective,
    referenceEntityVersionIds: run.basis.references.map(
      (reference) => reference.entityVersionId,
    ),
    // Each model call's findings are committed as it returns, so the run's
    // `completed` moves through a long review instead of jumping at the end.
    onGraded: async (findings) => {
      await upsertFindings(actor, toRows(findings));
    },
    ...deps,
  });

  // The whole set, once: the positions decided without a model are in no
  // batch, and the upsert converges on rows a batch already wrote.
  await upsertFindings(actor, toRows(graded));
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

/** Commit one batch of the pass's findings through the step both executors
 *  share. The run completes once, after the pass, in `finalizeRun`. */
const upsertFindings = async (
  actor: RunActor,
  rows: readonly FindingRow[],
): Promise<void> => {
  await actor.writeDb(
    async (tx) =>
      await writeReviewFindingBatch({
        tx,
        workspaceId: actor.workspaceId,
        rows,
        executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
        runId: actor.runId,
      }),
  );
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
  const finalized = await finalizeWorkerRun({
    actor,
    basis: run.basis,
    entityId: run.entityId,
    fileFieldId: run.fileFieldId,
    expectedFindingCount: plan.expectedFindingCount,
  });
  if (finalized.type === "incomplete") {
    return "internal";
  }
  reportFinalizedReviewRun(finalized, {
    workspaceId: actor.workspaceId,
    runId: actor.runId,
  });
  return null;
};

const setRunFailed = async (
  actor: RunActor,
  errorCode: DocumentReviewRunErrorCode,
): Promise<void> => {
  await actor.writeDb(
    async (tx) =>
      await failReviewRun(
        tx,
        { workspaceId: actor.workspaceId, runId: actor.runId },
        errorCode,
      ),
  );
};

export const documentReviewRunQueue = createDocumentRunQueue({
  name: "document-review-runs-v2",
  jobName: "run-document-review",
  contractVersion: QUEUE_CONTRACT_VERSION,
  actionKind: "document-reviews.background",
  limits: STANDARD_DOCUMENT_RUN_LIMITS,
  workerContext: undefined,
  actor: brandActor,
  claim: async ({ actor }) => await claimRun(actor),
  execute: executeRun,
  fail: async ({ actor, errorCode }) => await setRunFailed(actor, errorCode),
  readQueuedPage,
  failStuck: failStuckRuns,
});

export const enqueueDocumentReviewRun = async (
  args: EnqueueDocumentRunArgs<"documentReviewRun">,
): Promise<void> => {
  await documentReviewRunQueue.enqueue(args);
};

/**
 * Enqueue a whole matter's reviews in one round trip. A files-table run opens a
 * run per document, so adding them one at a time would be one Redis round trip
 * per document for no gain.
 */
export const enqueueDocumentReviewRuns = async (
  runs: readonly EnqueueDocumentRunArgs<"documentReviewRun">[],
): Promise<void> => {
  await documentReviewRunQueue.enqueueMany(runs);
};

export const reconcileQueuedDocumentReviewRuns = async ({
  db,
  queue,
}: {
  db: ReconcileDb;
  queue?: RequeueableQueue<DocumentRunJobData>;
}) =>
  await documentReviewRunQueue.reconcileQueued({
    db,
    ...(queue === undefined ? {} : { queue }),
  });

export const processDocumentReviewRun = async (
  actor: RunActor,
  admission: ModelDispatchAdmission,
): Promise<void> => {
  await documentReviewRunQueue.processRun({ actor, admission });
};

export const initDocumentReviewRunWorker = () =>
  documentReviewRunQueue.initWorker();
