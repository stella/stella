import { panic } from "better-result";
import type { Job } from "bullmq";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import {
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  workspaces,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import {
  isBackgroundFeatureEnabled,
  loadBackgroundFeatureActors,
} from "@/api/lib/feature-access/background";
import {
  executeFlowStep,
  failFlowRunFromWorker,
} from "@/api/lib/flows/flow-executor";
import type { FlowStepExecutionOutcome } from "@/api/lib/flows/flow-executor";
import {
  fileFlowRunCompletionNotice,
  flowRunActorExists,
  resolveActorUserId,
} from "@/api/lib/flows/flow-run-actor";
import {
  enqueueFlowStep,
  FLOW_RUN_QUEUE_NAME,
  persistFlowStepClaim,
  type FlowStepJobData,
} from "@/api/lib/flows/flow-run-queue";
import type { NotificationFanOutDb } from "@/api/lib/notifications";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { BACKGROUND_ACTION_KIND } from "@/api/lib/rate-limit/action-kinds";
import { runBackgroundJob } from "@/api/lib/rate-limit/queued-action-admission";
import { createBullMqConnection } from "@/api/lib/redis-client";
import {
  brandPersistedFlowRunId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

// The BullMQ worker side of the flow-run engine. It lives in its own module so
// the executor can depend on the queue's `enqueueFlowStep` without a cycle: the
// executor imports the queue, and only this worker imports the executor.

const FLOW_STEP_JOB_CONCURRENCY = 5;

// An `ai` step is the slow case; give the worker lock enough headroom to
// outlast one generation, while the stalled-job detector still reclaims a
// crashed worker's jobs.
const LOCK_DURATION_MS = 5 * 60 * 1000;
const STALLED_INTERVAL_MS = 30 * 1000;
const MAX_STALLED_COUNT = 2;

// Process-level ceiling per step job. Pipes an AbortSignal into the executor so
// the timeout actually cancels the in-flight AI request instead of leaving a
// hung job "active" and blocking follow-up steps.
const FLOW_STEP_JOB_TIMEOUT_MS = 4 * 60 * 1000;

// Batch size for the orphan re-enqueue scan. The scan keyset-paginates
// through every pending/running run rather than stopping at the first batch, so a
// backlog larger than one batch is still fully recovered.
const ORPHAN_SCAN_BATCH_SIZE = 1000;

type AdmittedFlowStepOptions = {
  job: Job<FlowStepJobData>;
  signal: AbortSignal;
  database: BullMqWorkerContext["db"];
  onClaim: (claimedStartedAt: TimestampCasToken) => void | Promise<void>;
};

const executeAdmittedFlowStep = async ({
  job,
  signal,
  database,
  onClaim,
}: AdmittedFlowStepOptions): Promise<FlowStepExecutionOutcome> => {
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    logger.info("flow.work_skipped", { reason: "deployment_disabled" });
    return { status: "paused" };
  }
  // Resolve tenant and actor from the durable run before granting model admission.
  const row = await database.query.flowRuns.findFirst({
    where: { id: { eq: brandPersistedFlowRunId(job.data.runId) } },
  });
  if (
    !row ||
    (row.status !== "pending" &&
      row.status !== "running" &&
      row.status !== "awaiting_review")
  ) {
    return { status: "completed" };
  }
  const workspace = await database.query.workspaces.findFirst({
    where: { id: { eq: row.workspaceId } },
    columns: { organizationId: true },
  });
  const actor = await resolveActorUserId(row, database);
  if (!workspace || !actor || !(await flowRunActorExists(actor, database))) {
    // The executor refuses a run without tenant or actor before any step.
    return await executeFlowStep(job.data, signal, {
      admission: null,
      database,
      onClaim,
    });
  }
  if (row.status === "awaiting_review") {
    return { status: "completed" };
  }
  if (
    !(await isBackgroundFeatureEnabled({
      tx: database,
      organizationId: workspace.organizationId,
      userId: actor,
      featureId: "flows",
    }))
  ) {
    logger.info("flow.work_skipped", {
      reason: "actor_not_granted",
      runId: row.id,
    });
    return { status: "paused" };
  }
  return await runBackgroundJob({
    actionKind: BACKGROUND_ACTION_KIND.flow,
    organizationId: workspace.organizationId,
    userId: actor,
    job,
    signal,
    run: async (executionSignal, admission) =>
      await executeFlowStep(job.data, executionSignal, {
        admission,
        database,
        onClaim,
      }),
  });
};

/**
 * Initialize the BullMQ worker for flow runs. Call once at API startup
 * (mirrors `initWorkflowWorker`). The worker owns a dedicated blocking Redis
 * connection.
 */
export const initFlowRunWorker = ({ db }: BullMqWorkerContext) => {
  const workerConnection = createBullMqConnection({
    storeClass: "durable-coordination",
  });

  const worker = new BullMqWorker<FlowStepJobData>(
    FLOW_RUN_QUEUE_NAME,
    async (job) => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort(
          new Error(
            `flow.step_timeout: run ${job.data.runId} step ${String(job.data.stepIndex)} exceeded ${FLOW_STEP_JOB_TIMEOUT_MS}ms`,
          ),
        );
      }, FLOW_STEP_JOB_TIMEOUT_MS);
      try {
        const outcome = await executeAdmittedFlowStep({
          job,
          signal: controller.signal,
          database: db,
          onClaim: async (claimedStartedAt) => {
            await persistFlowStepClaim(job, claimedStartedAt);
          },
        });
        // Surface a late abort so BullMQ marks the attempt failed rather than
        // completed if the signal fired after the last awaited call.
        controller.signal.throwIfAborted();
        switch (outcome.status) {
          case "paused":
            logger.info("flow.step_paused", { runId: job.data.runId });
            return;
          case "completed":
            return;
          case "stale":
            logger.info("flow.step_stale", { runId: job.data.runId });
            return;
          default:
            outcome satisfies never;
            return panic("Unknown flow step execution outcome");
        }
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    {
      connection: workerConnection,
      concurrency: FLOW_STEP_JOB_CONCURRENCY,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    },
  );

  worker.on("failed", (job, error) => {
    if (!job) {
      return;
    }
    logger.error("flow.step_failed", {
      runId: job.data.runId,
      stepIndex: String(job.data.stepIndex),
      attemptsMade: String(job.attemptsMade),
      "error.type": errorTag(error),
    });

    // With retries enabled the failed event also fires for a transient first
    // attempt; only flip the run to `failed` once BullMQ has exhausted its
    // attempts, otherwise a retry would run against an already-failed run.
    const totalAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < totalAttempts) {
      return;
    }

    failFlowRunFromWorker(job.data, error, {
      database: db,
      claimedStartedAt: job.data.claimedStartedAt,
    }).catch((finalizeError: unknown) => {
      captureError(finalizeError, {
        runId: job.data.runId,
        stepIndex: String(job.data.stepIndex),
      });
    });
  });

  worker.on("error", createQueueWorkerErrorLogger("flow.worker_error"));

  logger.info("flow.worker_started", {
    concurrency: String(FLOW_STEP_JOB_CONCURRENCY),
  });

  // Re-enqueue steps a previously-killed worker left mid-flight. A run in
  // `pending`/`running` whose step job was lost (hard kill, OOM, deploy
  // SIGTERM) would otherwise hang forever. Re-adding the current step is
  // idempotent: the deterministic job id no-ops a still-live job, and the
  // executor guards against re-running an already-completed step.
  // `awaiting_review` runs are intentionally parked on a human, not orphans.
  //
  // The standing reconciler (`flows.reconcileOrphanRuns`) covers the same
  // ground on a cadence, but only past a stall window. This call is kept
  // without one because a restart is proof that this process's in-flight
  // jobs are gone: waiting out the window would idle every run it just lost.
  reconcileOrphanedFlowRuns({}, { database: db }).catch((error: unknown) => {
    captureError(error);
    logger.error("flow.reconcile_failed", errorSystemFields(error));
  });

  return {
    queues: [FLOW_RUN_QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
    },
  };
};

type FlowStepsGrantPrincipal = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type ReconcileOrphanedFlowRunsOptions = {
  batchSize?: number;
  /** Regrant wakes only this principal's runs, including recent admission pauses. */
  principal?: FlowStepsGrantPrincipal;
  /**
   * Only reconcile runs that last moved before this instant. The standing
   * sweep passes one so a run the queue is still working on is left alone;
   * boot passes none, because a restart lost every job this process held.
   */
  stalledBefore?: Date;
  /**
   * The scheduler's runtime ceiling. A full-backlog drain can outlast the
   * lease, and a sweep still issuing queue writes after its lease is gone can
   * overlap the next cadence; checked between pages, so a drain stops at a
   * page boundary rather than mid-batch.
   */
  signal?: AbortSignal;
};

type ReconcileOrphanedFlowRunsDependencies = {
  database: Pick<typeof rootDb, "select" | "query"> & NotificationFanOutDb;
  enqueueStep?: typeof enqueueFlowStep;
};

type CompletionNoticeRepairOptions = Pick<
  ReconcileOrphanedFlowRunsOptions,
  "principal" | "signal"
> & { batchSize: number };

/** Only recorded delivery work enters this indexed recovery scan. */
const reconcilePendingFlowCompletionNotices = async (
  { principal, signal, batchSize }: CompletionNoticeRepairOptions,
  { database }: ReconcileOrphanedFlowRunsDependencies,
): Promise<void> => {
  let cursor:
    | { workspaceId: SafeId<"workspace">; id: SafeId<"flowRun"> }
    | undefined;
  const actorUserId = sql`CASE
    WHEN ${flowRuns.triggerSource}->>'type' = 'manual'
      THEN ${flowRuns.triggerSource}->>'userId'
    ELSE ${flowDefinitions.createdByUserId}
  END`;
  // Completed sources remain durable during opt-out without consuming the
  // bounded page ahead of recipients whose notices can currently be filed.
  const missingAdmittedCompletionNotice = and(
    eq(flowRuns.status, "completed"),
    isNotNull(featureEnrolments.userId),
    eq(user.emailVerified, true),
  );

  for (;;) {
    if (signal?.aborted === true) {
      return;
    }
    // db-await-in-loop: bounded indexed source pages advance in primary identity order.
    const batch = await database
      .select({
        id: flowRuns.id,
        workspaceId: flowRuns.workspaceId,
        organizationId: workspaces.organizationId,
        definitionId: flowRuns.definitionId,
        triggerSource: flowRuns.triggerSource,
        flowName: sql<string>`${flowRuns.definitionSnapshot}->>'name'`,
      })
      .from(flowRuns)
      .innerJoin(workspaces, eq(workspaces.id, flowRuns.workspaceId))
      .leftJoin(
        flowDefinitions,
        and(
          eq(flowDefinitions.id, flowRuns.definitionId),
          eq(flowDefinitions.organizationId, workspaces.organizationId),
        ),
      )
      .leftJoin(user, and(eq(user.id, actorUserId), isNull(user.deletedAt)))
      .leftJoin(
        member,
        and(
          eq(member.userId, user.id),
          eq(member.organizationId, workspaces.organizationId),
        ),
      )
      .leftJoin(
        featureEnrolments,
        and(
          eq(featureEnrolments.organizationId, member.organizationId),
          eq(featureEnrolments.userId, member.userId),
          eq(featureEnrolments.featureId, "flows"),
        ),
      )
      .where(
        and(
          eq(flowRuns.recoveryState, "completion-notice-pending"),
          or(missingAdmittedCompletionNotice, isNull(user.id)),
          principal === undefined
            ? undefined
            : and(
                eq(workspaces.organizationId, principal.organizationId),
                eq(actorUserId, principal.userId),
              ),
          cursor === undefined
            ? undefined
            : or(
                gt(flowRuns.workspaceId, cursor.workspaceId),
                and(
                  eq(flowRuns.workspaceId, cursor.workspaceId),
                  gt(flowRuns.id, cursor.id),
                ),
              ),
        ),
      )
      .orderBy(asc(flowRuns.workspaceId), asc(flowRuns.id))
      .limit(batchSize);
    for (const row of batch) {
      // db-await-in-loop: each notice commits under the recipient admission fence.
      await fileFlowRunCompletionNotice(
        {
          run: {
            definitionId: row.definitionId,
            triggerSource: row.triggerSource,
          },
          organizationId: row.organizationId,
          workspaceId: row.workspaceId,
          runId: row.id,
          flowName: row.flowName,
        },
        database,
      );
    }
    const last = batch.at(-1);
    if (last === undefined || batch.length < batchSize) {
      return;
    }
    cursor = { workspaceId: last.workspaceId, id: last.id };
  }
};

// Keyset-paginate runnable steps without revisiting an already enqueued page.
// Re-adding the step does not change the row's status, so a plain
// `LIMIT` scan would re-select the same head of the backlog on every restart and
// never reach the tail; ordering by id and advancing a cursor visits each run
// exactly once until the backlog is drained. `batchSize` is injectable so tests
// can exercise the multi-batch path without seeding thousands of rows.
export const reconcileOrphanedFlowRuns = async (
  {
    batchSize = ORPHAN_SCAN_BATCH_SIZE,
    principal,
    stalledBefore,
    signal,
  }: ReconcileOrphanedFlowRunsOptions,
  {
    database,
    enqueueStep = enqueueFlowStep,
  }: ReconcileOrphanedFlowRunsDependencies,
): Promise<void> => {
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    logger.info("flow.work_skipped", { reason: "deployment_disabled" });
    return;
  }
  await reconcilePendingFlowCompletionNotices(
    {
      batchSize,
      ...(principal === undefined ? {} : { principal }),
      ...(signal === undefined ? {} : { signal }),
    },
    { database },
  );
  let cursor: SafeId<"flowRun"> | null = null;
  let reconciled = 0;
  const actorUserId = sql`CASE
    WHEN ${flowRuns.triggerSource}->>'type' = 'manual'
      THEN ${flowRuns.triggerSource}->>'userId'
    ELSE ${flowDefinitions.createdByUserId}
  END`;

  for (;;) {
    if (signal?.aborted === true) {
      break;
    }
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const batch = await database
      .select({
        id: flowRuns.id,
        currentStepIndex: flowRuns.currentStepIndex,
        createdByUserId: flowDefinitions.createdByUserId,
        existingActorUserId: user.id,
        triggerSource: flowRuns.triggerSource,
        organizationId: workspaces.organizationId,
      })
      .from(flowRuns)
      .innerJoin(workspaces, eq(workspaces.id, flowRuns.workspaceId))
      .leftJoin(
        flowDefinitions,
        and(
          eq(flowDefinitions.id, flowRuns.definitionId),
          eq(flowDefinitions.organizationId, workspaces.organizationId),
        ),
      )
      .leftJoin(
        flowRunSteps,
        and(
          eq(flowRunSteps.runId, flowRuns.id),
          eq(flowRunSteps.workspaceId, flowRuns.workspaceId),
          eq(flowRunSteps.index, flowRuns.currentStepIndex),
        ),
      )
      .leftJoin(user, and(eq(user.id, actorUserId), isNull(user.deletedAt)))
      .leftJoin(
        member,
        and(
          eq(member.userId, user.id),
          eq(member.organizationId, workspaces.organizationId),
        ),
      )
      .where(
        and(
          inArray(flowRuns.status, ["pending", "running"]),
          principal === undefined
            ? undefined
            : and(
                eq(workspaces.organizationId, principal.organizationId),
                or(
                  and(
                    eq(sql`${flowRuns.triggerSource}->>'type'`, "manual"),
                    eq(
                      sql`${flowRuns.triggerSource}->>'userId'`,
                      principal.userId,
                    ),
                  ),
                  and(
                    inArray(sql`${flowRuns.triggerSource}->>'type'`, [
                      "schedule",
                      "file-upload",
                    ]),
                    eq(flowDefinitions.createdByUserId, principal.userId),
                  ),
                ),
              ),
          cursor === null ? undefined : gt(flowRuns.id, cursor),
          // `startedAt` moves when the run leaves `pending`; `createdAt` is
          // the only timestamp a run that never started has.
          stalledBefore === undefined
            ? undefined
            : lt(
                sql`CASE WHEN ${flowRuns.status} = 'running' THEN ${flowRunSteps.startedAt} ELSE coalesce(${flowRuns.startedAt}, ${flowRuns.createdAt}) END`,
                stalledBefore,
              ),
        ),
      )
      .orderBy(asc(flowRuns.id))
      .limit(batchSize);

    if (batch.length === 0) {
      break;
    }

    const actors = new Map<SafeId<"flowRun">, SafeId<"user">>();
    for (const row of batch) {
      switch (row.triggerSource.type) {
        case "manual":
          actors.set(row.id, brandPersistedUserId(row.triggerSource.userId));
          break;
        case "schedule":
        case "file-upload":
          if (row.createdByUserId !== null) {
            actors.set(row.id, brandPersistedUserId(row.createdByUserId));
          }
          break;
        default:
          row.triggerSource satisfies never;
          return panic("Unknown flow trigger source");
      }
    }
    const admitted = await loadBackgroundFeatureActors({
      tx: database,
      featureId: "flows",
      principals: batch.flatMap((row) => {
        const userId = actors.get(row.id);
        return userId === undefined
          ? []
          : [{ organizationId: row.organizationId, userId }];
      }),
    });
    // A missing organization membership pauses a live actor; only a missing
    // user enters actor-removal recovery. The tenant-scoped page carries both.
    const existingActors = new Set(
      batch.flatMap(({ existingActorUserId }) =>
        existingActorUserId === null ? [] : [existingActorUserId],
      ),
    );
    for (const row of batch) {
      const actor = actors.get(row.id);
      if (
        actor !== undefined &&
        existingActors.has(actor) &&
        admitted.get(row.organizationId)?.has(actor) !== true
      ) {
        logger.info("flow.work_skipped", {
          reason: "actor_not_granted",
          runId: row.id,
        });
        continue;
      }
      // An unavailable actor records actor-removed without deleting outputs;
      // a live actor's opt-out remains paused until re-grant.
      await enqueueStep({ runId: row.id, stepIndex: row.currentStepIndex });
      reconciled += 1;
    }

    const lastRow = batch.at(-1);
    if (lastRow === undefined || batch.length < batchSize) {
      break;
    }
    cursor = lastRow.id;
  }

  if (reconciled > 0) {
    logger.info("flow.orphans_reconciled", { count: String(reconciled) });
  }
};

/** Call after the grant commits; durable runs remain recoverable if queue I/O fails. */
export const resumeFlowStepsAfterGrant = async (
  principal: FlowStepsGrantPrincipal,
  dependencies: ReconcileOrphanedFlowRunsDependencies,
): Promise<void> => {
  await reconcileOrphanedFlowRuns({ principal }, dependencies);
};
