/**
 * Background queue for fact extraction: a generation run stella produces,
 * the same one-shot shape as the list verification queue.
 *
 * `attempts: 1`: every run spends metered model calls, so a retry would pay
 * twice. Any failure lands `status: "failed"` with a closed error code, and a
 * person retries by starting a new run.
 *
 * Convergence: the job id is the run id, only a `queued` run stella produces
 * is claimable, and every later write is conditional on the run still
 * running. A re-delivered job is a no-op. External runs are never claimed:
 * their candidates come from the client that started them.
 */

import { Result, TaggedError } from "better-result";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { DAY_IN_MS, Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  fields,
  legalListGenerationRuns,
  legalListGenerationSources,
} from "@/api/db/schema";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import {
  QUEUE_REQUEUE_OUTCOME,
  requeueDeterministicJob,
} from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";
import { LIMITS } from "@/api/lib/limits";
import { candidateFactDetailColumns } from "@/api/lib/lists/generation/candidate-fact-details";
import type { ListGenerationRunErrorCode } from "@/api/lib/lists/generation/contract";
import { extractFacts } from "@/api/lib/lists/generation/fact-extract";
import type { ExtractedFact } from "@/api/lib/lists/generation/fact-extract";
import {
  claimGenerationRun,
  completeGenerationRun,
  failGenerationRun,
  GENERATION_RUN_ACTIVE_STATUSES,
} from "@/api/lib/lists/generation/run-persistence";
import type { GeneratedCandidate } from "@/api/lib/lists/generation/run-persistence";
import type { ListVerificationAccessProof } from "@/api/lib/lists/verification/access";
import { resolveListVerificationAccess } from "@/api/lib/lists/verification/access-context";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import { readVerificationDocument } from "@/api/lib/lists/verification/document-text";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import { ListVerificationAccessRevokedError } from "@/api/lib/lists/verification/model-call";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  scanPendingRows,
} from "@/api/lib/queue-reconcile-scan";
import type { ReconcileScanResult } from "@/api/lib/queue-reconcile-scan";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { runBackgroundJob } from "@/api/lib/rate-limit/queued-action-admission";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import {
  brandPersistedLegalListGenerationRunId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { findExtractionFileFieldRow } from "@/api/lib/search/types";
import {
  checkModelRunCaps,
  ModelRunCapError,
} from "@/api/lib/usage/model-run-caps/caps";

/** An extraction's model calls re-check the list counter it was charged to. */
const EXTRACTION_DISPATCH_CAPS = {
  kind: "list-run",
  operation: "lists.fact-extractions.create",
  phase: "dispatch",
} as const;

const QUEUE_NAME = "legal-list-generation-runs";
/** Fields read per pinned version when choosing its file. */
const VERSION_FIELDS_READ_MAX = 200;
const JOB_NAME = "run-list-fact-extraction";
const WORKER_CONCURRENCY = 2;
const JOB_ATTEMPTS = 1;
/** Budget for the whole run; each model call carries its own timeout. Stays
 *  under `STUCK_RUNNING_MS`, which catches a worker that died. */
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const SERVICE_TIER = "standard" as const;
const STUCK_RUNNING_MS = 30 * 60 * 1000;
/** Younger `queued` rows may simply be backlogged. */
const STUCK_QUEUED_MS = DAY_IN_MS;

const CONFIG_FAILED_SINK = failureSink({
  event: "list_fact_extraction_run.config_failed",
  expected: [],
});
const RUN_FAILED_SINK = failureSink({
  event: "list_fact_extraction_run.failed",
  expected: [],
});
const MARK_FAILED_SINK = failureSink({
  event: "list_fact_extraction_run.mark_failed_failed",
  expected: [],
});

type FactExtractionJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

type EnqueueFactExtractionRunArgs = {
  runId: SafeId<"legalListGenerationRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<FactExtractionJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** The run id is the job identity, so a duplicate enqueue collapses. */
const runJob = ({
  runId,
  workspaceId,
  organizationId,
  userId,
}: EnqueueFactExtractionRunArgs) => ({
  name: JOB_NAME,
  data: {
    runId,
    workspaceId,
    organizationId,
    userId,
  } satisfies FactExtractionJobData,
  opts: { jobId: createBullMqJobId(workspaceId, runId) },
});

export const enqueueFactExtractionRun = async (
  args: EnqueueFactExtractionRunArgs,
): Promise<void> => {
  const { name, data, opts } = runJob(args);
  await getQueue().add(name, data, opts);
};

const runCursorCodec = createTimestampIdCursorCodec({
  column: legalListGenerationRuns.createdAt,
  brandId: brandPersistedLegalListGenerationRunId,
});

type ActiveRunRow = Awaited<ReturnType<typeof readActiveRunPage>>[number];

/** Unfinished runs stella produces, oldest first; the partial index
 *  `legal_list_generation_runs_stella_active_idx` serves this walk. */
const readActiveRunPage = async (
  db: Pick<SchedulerDb, "select">,
  cursor: {
    createdCursor: string;
    id: SafeId<"legalListGenerationRun">;
  } | null,
  status?: "queued",
) =>
  await db
    .select({
      createdCursor: runCursorCodec.cursorValue,
      createdAt: legalListGenerationRuns.createdAt,
      startedAt: legalListGenerationRuns.startedAt,
      status: legalListGenerationRuns.status,
      id: legalListGenerationRuns.id,
      organizationId: legalListGenerationRuns.organizationId,
      requestedBy: legalListGenerationRuns.requestedBy,
      workspaceId: legalListGenerationRuns.workspaceId,
    })
    .from(legalListGenerationRuns)
    .where(
      and(
        eq(legalListGenerationRuns.producer, "stella"),
        status === "queued"
          ? eq(legalListGenerationRuns.status, status)
          : inArray(legalListGenerationRuns.status, [
              ...GENERATION_RUN_ACTIVE_STATUSES,
            ]),
        cursor === null
          ? undefined
          : runCursorCodec.keysetAfter({
              cursor: {
                timestamp: reconcileCursorTimestamp(cursor.createdCursor),
                id: cursor.id,
              },
              idColumn: legalListGenerationRuns.id,
              direction: "ascending",
            }),
      ),
    )
    .orderBy(
      asc(legalListGenerationRuns.createdAt),
      asc(legalListGenerationRuns.id),
    )
    .limit(RECONCILE_SCAN_PAGE_SIZE);

type RunScope = {
  id: SafeId<"legalListGenerationRun">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type ResolveRunAccessArgs = {
  tx: Pick<Transaction, "select">;
  run: RunScope;
  grants?: FeatureAccessGrants | undefined;
  requesterId?: string;
  expectedStatus?: "running";
};

/**
 * The requester's access as it stands now, for a run that is still
 * unfinished (and still running, when asked). A run whose requester is gone
 * is unavailable.
 */
const resolveFactExtractionRunAccess = async ({
  tx,
  run,
  grants,
  requesterId,
  expectedStatus,
}: ResolveRunAccessArgs) => {
  const persisted = (
    await tx
      .select({
        requestedBy: legalListGenerationRuns.requestedBy,
        status: legalListGenerationRuns.status,
      })
      .from(legalListGenerationRuns)
      .where(
        and(
          eq(legalListGenerationRuns.id, run.id),
          eq(legalListGenerationRuns.organizationId, run.organizationId),
          eq(legalListGenerationRuns.workspaceId, run.workspaceId),
          eq(legalListGenerationRuns.producer, "stella"),
        ),
      )
      .limit(1)
  ).at(0);
  if (
    persisted === undefined ||
    (persisted.status !== "queued" && persisted.status !== "running") ||
    (requesterId !== undefined && persisted.requestedBy !== requesterId) ||
    (expectedStatus !== undefined && persisted.status !== expectedStatus)
  ) {
    return { status: "unavailable" } as const;
  }
  return await resolveListVerificationAccess({
    tx,
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    userId: persisted.requestedBy,
    grants,
  });
};

/** A run recorded without its organization is never stella's; the check
 *  constraint makes this unreachable. */
const scopeOf = (run: ActiveRunRow): RunScope | null =>
  run.organizationId === null
    ? null
    : {
        id: run.id,
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
      };

/**
 * Fail runs a hard worker death left behind: a `kill -9` emits no `failed`
 * event, and the claim guard makes a stalled re-delivery a no-op, so the run
 * would hold one of its organization's active slots forever. Runs whose
 * requester lost access are failed too. Cross-workspace, so it runs on the
 * scheduler's handle.
 */
export const reconcileStuckFactExtractionRuns = async (
  db: Pick<SchedulerDb, "select" | "transaction">,
  grants?: FeatureAccessGrants,
): Promise<number> => {
  let recovered = 0;
  await scanPendingRows({
    readPage: async (cursor: ActiveRunRow | null) =>
      await readActiveRunPage(db, cursor),
    handle: async (row) => {
      const run = scopeOf(row);
      if (run === null) {
        return false;
      }
      const now = Temporal.Now.instant().epochMilliseconds;
      const stale =
        row.status === "running"
          ? row.startedAt !== null &&
            row.startedAt.getTime() < now - STUCK_RUNNING_MS
          : row.createdAt.getTime() < now - STUCK_QUEUED_MS;
      const transitioned = await withAggregateTransaction(db, async (tx) => {
        const access = await resolveFactExtractionRunAccess({
          tx,
          run,
          grants,
        });
        if (access.status === "available" && !stale) {
          return false;
        }
        return await failGenerationRun({
          tx,
          run,
          errorCode:
            access.status === "unavailable" ? "access_revoked" : "internal",
          expectedStatus: row.status === "running" ? "running" : "queued",
        });
      });
      if (transitioned) {
        recovered += 1;
      }
      return false;
    },
  });
  return recovered;
};

export class FactExtractionReconcileError extends TaggedError(
  "FactExtractionReconcileError",
)<{
  message: string;
  cause: unknown;
}> {}

type ReconcileQueuedRunsResult = ReconcileScanResult & {
  /** Runs whose requester is gone; their active slot was closed. */
  unattributed: number;
};

type ReconcileQueuedOptions = {
  db: Pick<SchedulerDb, "select" | "transaction">;
  queue?: RequeueableQueue<FactExtractionJobData>;
  grants?: FeatureAccessGrants | undefined;
};

/**
 * Hand `queued` runs back to the queue when nothing owns them. The row
 * commits before the job is added, so a crash in between, or a queue that
 * lost its jobs, leaves a run no worker will pick up. Re-adding is safe: the
 * job id is the run id and only a `queued` row is claimable.
 */
export const reconcileQueuedFactExtractionRuns = async ({
  db,
  queue = getQueue(),
  grants,
}: ReconcileQueuedOptions): Promise<
  Result<ReconcileQueuedRunsResult, FactExtractionReconcileError>
> => {
  let unattributed = 0;
  const scan = await Result.tryPromise({
    try: async () =>
      await scanPendingRows({
        readPage: async (cursor: ActiveRunRow | null) =>
          await readActiveRunPage(db, cursor, "queued"),
        handle: async (row) => {
          const run = scopeOf(row);
          if (run === null) {
            return false;
          }
          const access = await withAggregateTransaction(db, async (tx) => {
            const decision = await resolveFactExtractionRunAccess({
              tx,
              run,
              grants,
            });
            if (decision.status === "unavailable") {
              await failGenerationRun({
                tx,
                run,
                errorCode: "access_revoked",
                expectedStatus: "queued",
              });
            }
            return decision;
          });
          if (access.status === "unavailable" || row.requestedBy === null) {
            if (row.requestedBy === null) {
              unattributed += 1;
            }
            return false;
          }
          const { name, data, opts } = runJob({
            runId: run.id,
            workspaceId: run.workspaceId,
            organizationId: run.organizationId,
            userId: brandPersistedUserId(row.requestedBy),
          });
          const outcome = await requeueDeterministicJob({
            data,
            name,
            jobId: opts.jobId,
            queue,
          });
          return outcome === QUEUE_REQUEUE_OUTCOME.REQUEUED;
        },
      }),
    catch: (cause) => {
      observeFailure(cause, {
        sink: RUN_FAILED_SINK,
        ctx: { queue: QUEUE_NAME },
      });
      return new FactExtractionReconcileError({
        message: "Fact extraction reconciliation failed",
        cause,
      });
    },
  });
  if (Result.isError(scan)) {
    return scan;
  }
  return Result.ok({ ...scan.value, unattributed });
};

type RunActor = RootRunActor<"legalListGenerationRun">;

const brandActor = (data: FactExtractionJobData): RunActor =>
  createRootRunActor(data, brandPersistedLegalListGenerationRunId);

const actorRun = (actor: RunActor): RunScope => ({
  id: actor.runId,
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
});

type ClaimedRun = {
  instruction: string;
};

/** Conditional `queued -> running`: the loser of a double delivery, and any
 *  run stella does not produce, updates nothing and stops. */
const claimRun = async (
  tx: Transaction,
  actor: RunActor,
): Promise<ClaimedRun | null> => {
  const claimed = await claimGenerationRun({
    tx,
    run: actorRun(actor),
    requestedBy: actor.userId,
  });
  if (!claimed) {
    return null;
  }
  const run = (
    await tx
      .select({ instruction: legalListGenerationRuns.instruction })
      .from(legalListGenerationRuns)
      .where(
        and(
          eq(legalListGenerationRuns.id, actor.runId),
          eq(legalListGenerationRuns.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  return run ?? null;
};

const setRunFailed = async ({
  actor,
  errorCode,
  grants,
}: {
  actor: RunActor;
  errorCode: ListGenerationRunErrorCode;
  grants?: FeatureAccessGrants | undefined;
}): Promise<void> => {
  await actor.writeDb(async (tx) => {
    const access = await resolveFactExtractionRunAccess({
      tx,
      run: actorRun(actor),
      requesterId: actor.userId,
      grants,
    });
    await failGenerationRun({
      tx,
      run: actorRun(actor),
      errorCode: access.status === "unavailable" ? "access_revoked" : errorCode,
    });
  });
};

type PinnedSource = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  file: { fileId: string; mimeType: string; pdfFileId: string | null };
};

/**
 * Every source version the run pinned, with the file it carries, read under
 * the requester's current membership: a requester who lost the matter
 * resolves nothing. A source whose version is gone or carries no readable
 * file fails the run rather than silently narrowing what it read.
 */
const resolvePinnedSources = async (
  actor: RunActor,
): Promise<Result<PinnedSource[], ListGenerationRunErrorCode>> => {
  const resolved = await actor.inputDb(async (tx) => {
    const sourceRead = await readBounded(
      tx
        .select({
          entityId: legalListGenerationSources.sourceEntityId,
          entityVersionId: legalListGenerationSources.sourceEntityVersionId,
          liveVersionId: entityVersions.id,
          documentId: entities.id,
        })
        .from(legalListGenerationSources)
        .leftJoin(
          entityVersions,
          and(
            eq(
              entityVersions.id,
              legalListGenerationSources.sourceEntityVersionId,
            ),
            eq(
              entityVersions.entityId,
              legalListGenerationSources.sourceEntityId,
            ),
            eq(
              entityVersions.workspaceId,
              legalListGenerationSources.workspaceId,
            ),
            isNull(entityVersions.deletedAt),
          ),
        )
        .leftJoin(
          entities,
          and(
            eq(entities.id, legalListGenerationSources.sourceEntityId),
            eq(entities.workspaceId, legalListGenerationSources.workspaceId),
            eq(entities.kind, "document"),
          ),
        )
        .where(
          and(
            eq(legalListGenerationSources.workspaceId, actor.workspaceId),
            eq(legalListGenerationSources.runId, actor.runId),
          ),
        )
        .orderBy(asc(legalListGenerationSources.id)),
      LIMITS.legalListGenerationSourcesMax,
    );
    // A run pins at most this many sources; more cannot be a run's own.
    if (sourceRead.type === "overflow") {
      return null;
    }
    const sources = sourceRead.rows;
    if (
      sources.some(
        (source) => source.liveVersionId === null || source.documentId === null,
      )
    ) {
      return null;
    }
    const versionFieldRead = await readBounded(
      tx
        .select({
          id: fields.id,
          entityVersionId: fields.entityVersionId,
          content: fields.content,
        })
        .from(fields)
        .where(
          and(
            eq(fields.workspaceId, actor.workspaceId),
            inArray(
              fields.entityVersionId,
              sources.map((source) => source.entityVersionId),
            ),
          ),
        )
        // Ascending id is creation order, which the file choice needs.
        .orderBy(asc(fields.id)),
      LIMITS.legalListGenerationSourcesMax * VERSION_FIELDS_READ_MAX,
    );
    // More fields than the pinned versions can carry reads as unavailable.
    return versionFieldRead.type === "overflow"
      ? null
      : { sources, versionFields: versionFieldRead.rows };
  });
  if (resolved === null || resolved.sources.length === 0) {
    return Result.err("source_unavailable");
  }
  const pinned: PinnedSource[] = [];
  for (const source of resolved.sources) {
    const field = findExtractionFileFieldRow(
      resolved.versionFields.filter(
        (candidate) => candidate.entityVersionId === source.entityVersionId,
      ),
    );
    if (field === null) {
      return Result.err("source_unavailable");
    }
    if (field.content.encrypted) {
      return Result.err("unsupported_format");
    }
    pinned.push({
      entityId: source.entityId,
      entityVersionId: source.entityVersionId,
      file: {
        fileId: field.content.id,
        mimeType: field.content.mimeType,
        pdfFileId: field.content.pdfFileId,
      },
    });
  }
  return Result.ok(pinned);
};

/** Trusted process-local I/O boundaries; never sourced from queued data. */
export type FactExtractionExecutionBoundaries = {
  readDocument?: typeof readVerificationDocument;
  generateObjectForTask?: VerificationModelDeps["generateObjectForTask"];
};

type ReadSource = PinnedSource & { blocks: VerificationBlock[] };

type ExecuteRunArgs = {
  actor: RunActor;
  admission: ModelDispatchAdmission;
  run: ClaimedRun;
  accessProof: ListVerificationAccessProof;
  grants?: FeatureAccessGrants | undefined;
  execution?: FactExtractionExecutionBoundaries;
};

const failureOf = (cause: unknown): ListGenerationRunErrorCode => {
  if (cause instanceof ModelRunCapError) {
    return "run_limit_reached";
  }
  return cause instanceof ListVerificationAccessRevokedError
    ? "access_revoked"
    : "extraction_failed";
};

const candidateOf = (
  source: PinnedSource,
  fact: ExtractedFact,
): GeneratedCandidate => ({
  name: fact.name,
  description: null,
  itemType: "fact",
  ...candidateFactDetailColumns(fact.details),
  sources: [
    {
      sourceEntityId: source.entityId,
      sourceEntityVersionId: source.entityVersionId,
      locator: fact.locator,
      quote: fact.quote,
    },
  ],
});

/** Null on success, else the code the run failed with. */
const executeRun = async ({
  actor,
  admission,
  run,
  accessProof,
  grants,
  execution = {},
}: ExecuteRunArgs): Promise<ListGenerationRunErrorCode | null> => {
  const pinned = await resolvePinnedSources(actor);
  if (Result.isError(pinned)) {
    return pinned.error;
  }
  const abortSignal = AbortSignal.timeout(RUN_TIMEOUT_MS);
  const readDocument = execution.readDocument ?? readVerificationDocument;
  const read: ReadSource[] = [];
  let blockCount = 0;
  for (const source of pinned.value) {
    const document = await readDocument({
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      file: source.file,
      signal: abortSignal,
    });
    if (document.type === "unsupported-format") {
      return "unsupported_format";
    }
    if (document.type === "no-text") {
      return "no_text";
    }
    blockCount += document.blocks.length;
    if (blockCount > VERIFICATION_LIMITS.BLOCKS_PER_RUN_MAX) {
      return "extraction_failed";
    }
    read.push({ ...source, blocks: document.blocks });
  }

  const settings = await Result.tryPromise({
    try: async () =>
      await actor.writeDb(async (tx) => await loadOrgAISettings(tx, actor)),
    catch: (cause) => cause,
  });
  const config = Result.flatten(settings);
  if (Result.isError(config)) {
    observeFailure(config.error, {
      sink: CONFIG_FAILED_SINK,
      ctx: { runId: actor.runId, workspaceId: actor.workspaceId },
    });
    return "ai_unavailable";
  }

  const resolveRunningAccess = async () =>
    await actor.writeDb(
      async (tx) =>
        await resolveFactExtractionRunAccess({
          tx,
          run: actorRun(actor),
          requesterId: actor.userId,
          expectedStatus: "running",
          grants,
        }),
    );
  const baseDeps = {
    admission,
    accessProof,
    checkRunBudget: async () =>
      await actor.writeDb(
        async (tx) =>
          await checkModelRunCaps({
            tx,
            organizationId: actor.organizationId,
            ...EXTRACTION_DISPATCH_CAPS,
          }),
      ),
    ...(execution.generateObjectForTask === undefined
      ? {}
      : { generateObjectForTask: execution.generateObjectForTask }),
    refreshAccessProof: async () => {
      const decision = await resolveRunningAccess();
      return decision.status === "unavailable" ? null : decision.proof;
    },
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    orgAIConfig: config.value.orgAIConfig,
    managedAIResidency: config.value.managedAIResidency,
    promptCachingEnabled: config.value.promptCachingEnabled,
    serviceTier: SERVICE_TIER,
    usageMetering: {
      actionType: "doc_review",
      organizationId: actor.organizationId,
      safeDb: actor.writeSafeDb,
      serviceTier: SERVICE_TIER,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
    },
    abortSignal,
  } satisfies Omit<VerificationModelDeps, "entityVersionId">;

  const candidates: GeneratedCandidate[] = [];
  // Documents in the order the run pinned them; facts in reading order.
  for (const source of read) {
    const extracted = await extractFacts({
      blocks: source.blocks,
      request: run.instruction,
      deps: { ...baseDeps, entityVersionId: source.entityVersionId },
    });
    if (Result.isError(extracted)) {
      const code = failureOf(extracted.error.cause);
      if (code === "extraction_failed") {
        observeFailure(extracted.error, {
          sink: RUN_FAILED_SINK,
          ctx: { runId: actor.runId, workspaceId: actor.workspaceId },
        });
      }
      return code;
    }
    candidates.push(
      ...extracted.value.map((fact) => candidateOf(source, fact)),
    );
  }

  await actor.writeDb(async (tx) => {
    const access = await resolveFactExtractionRunAccess({
      tx,
      run: actorRun(actor),
      requesterId: actor.userId,
      expectedStatus: "running",
      grants,
    });
    if (access.status === "unavailable") {
      await failGenerationRun({
        tx,
        run: actorRun(actor),
        errorCode: "access_revoked",
        expectedStatus: "running",
      });
      return;
    }
    await completeGenerationRun({
      tx,
      run: actorRun(actor),
      // A run proposes at most this many; the rest of a very long record is
      // left for a narrower request.
      candidates: candidates.slice(0, LIMITS.legalListGenerationCandidatesMax),
    });
  });
  return null;
};

type ProcessFactExtractionRunArgs = {
  data: FactExtractionJobData;
  admission: ModelDispatchAdmission;
  actor?: RunActor;
  grants?: FeatureAccessGrants | undefined;
  execution?: FactExtractionExecutionBoundaries;
};

export const processFactExtractionRun = async ({
  data,
  admission,
  actor = brandActor(data),
  grants,
  execution,
}: ProcessFactExtractionRunArgs): Promise<void> => {
  const claim = await actor.writeDb(async (tx) => {
    const access = await resolveFactExtractionRunAccess({
      tx,
      run: actorRun(actor),
      requesterId: actor.userId,
      grants,
    });
    if (access.status === "unavailable") {
      await failGenerationRun({
        tx,
        run: actorRun(actor),
        errorCode: "access_revoked",
        expectedStatus: "queued",
      });
      return null;
    }
    const claimed = await claimRun(tx, actor);
    return claimed === null ? null : { run: claimed, proof: access.proof };
  });
  if (claim === null) {
    return;
  }
  const outcome = await Result.tryPromise({
    try: async () =>
      await executeRun({
        actor,
        admission,
        run: claim.run,
        accessProof: claim.proof,
        grants,
        ...(execution === undefined ? {} : { execution }),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(outcome)) {
    observeFailure(outcome.error, {
      sink: RUN_FAILED_SINK,
      ctx: { runId: actor.runId, workspaceId: actor.workspaceId },
    });
    await setRunFailed({
      actor,
      errorCode:
        outcome.error instanceof ListVerificationAccessRevokedError
          ? "access_revoked"
          : "internal",
      grants,
    });
    return;
  }
  if (outcome.value !== null) {
    await setRunFailed({ actor, errorCode: outcome.value, grants });
  }
};

export const initFactExtractionRunWorker = () => {
  const worker = new BullMqWorker<FactExtractionJobData>(
    QUEUE_NAME,
    async (job) => {
      const actor = brandActor(job.data);
      // The run's period action was drawn when it was queued; the job takes
      // a background slot. The run bounds its own time.
      await runBackgroundJob({
        actionKind: "list-fact-extraction.background",
        organizationId: actor.organizationId,
        userId: actor.userId,
        organizationStateDb: actor.writeDb,
        job,
        signal: new AbortController().signal,
        run: async (_signal, admission) =>
          await processFactExtractionRun({
            data: job.data,
            actor,
            admission,
          }),
      });
    },
    {
      connection: createBullMqConnection({
        storeClass: "durable-coordination",
      }),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    if (job) {
      detached(
        async () =>
          setRunFailed({
            actor: brandActor(job.data),
            errorCode: "internal",
          }).catch((markError: unknown) => {
            observeFailure(markError, {
              sink: MARK_FAILED_SINK,
              ctx: { runId: job.data.runId, workspaceId: job.data.workspaceId },
            });
          }),
        "list-fact-extraction.set-run-failed",
      );
    }
    observeFailure(error, {
      sink: RUN_FAILED_SINK,
      ctx: {
        queue: QUEUE_NAME,
        ...(job
          ? { runId: job.data.runId, workspaceId: job.data.workspaceId }
          : {}),
      },
    });
  });

  worker.on(
    "error",
    createQueueWorkerErrorLogger("list_fact_extraction_run.worker_error", {
      queue: QUEUE_NAME,
    }),
  );

  logger.info("list_fact_extraction_run.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    queues: [QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
    },
  };
};
