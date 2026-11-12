/**
 * The one owner of a document run queue: a one-shot BullMQ queue whose job is
 * a run row a member asked for over one document (a document review, a list
 * verification).
 *
 * The skeleton every such queue shares lives here and nowhere else:
 *
 * - One attempt. A run spends metered model calls, so a BullMQ retry would pay
 *   twice. Any failure lands the row `failed` with a closed error code, and a
 *   person retries by starting a new run.
 * - The job id is the run id, so a duplicate enqueue collapses onto the job in
 *   flight, and only a `queued` row is claimable, so a re-delivered job is a
 *   no-op rather than a second metered execution.
 * - Bounded time. A run's budget stays under the age at which a `running` row
 *   counts as stuck, and a `queued` row counts as stuck only once it is older
 *   than any backlog.
 * - Recovery. `reconcileQueued` hands a `queued` run no job owns back to the
 *   queue (the row commits before the job is added, so a crash in between, or
 *   a queue that lost its jobs, leaves a run nothing would pick up);
 *   `reconcileStuck` fails rows a dead worker or a lost job left behind (a
 *   `kill -9` emits no `failed` event, and the claim guard turns BullMQ's
 *   stalled re-delivery into a no-op).
 *
 * A feature supplies only what is its own: its table's reads and transitions
 * (`claim`, `fail`, `readQueuedPage`, `admitQueued`, `failStuck`) and its
 * `execute`. `scripts/queue-authority.ts` reads a feature's
 * `createDocumentRunQueue` call as that module's Worker, and the
 * `no-hand-built-document-run-queue` lint rule keeps a document run table from
 * getting a queue built by hand.
 */

import { panic, Result, TaggedError } from "better-result";

import { DAY_IN_MS } from "@stll/time";

import { detached } from "@/api/lib/analytics/capture";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import type { BullMqQueueName } from "@/api/lib/bullmq-queue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { reconcileQueuedRuns } from "@/api/lib/queue-reconcile-scan";
import type { ReconcileQueuedRunsResult } from "@/api/lib/queue-reconcile-scan";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import type { ConcurrencyOnlyActionKind } from "@/api/lib/rate-limit/action-kinds";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { runBackgroundJob } from "@/api/lib/rate-limit/queued-action-admission";
import { createBullMqConnection } from "@/api/lib/redis-client";
import type { RootRunActor } from "@/api/lib/root-scoped-db";

const WORKER_CONCURRENCY = 2;
// One attempt: a retry would re-run metered model calls. Failures are
// persisted on the row instead.
const JOB_ATTEMPTS = 1;

const RUN_FAILED_SINK = failureSink({
  event: "document_run.failed",
  expected: [],
});
const MARK_FAILED_SINK = failureSink({
  event: "document_run.mark_failed_failed",
  expected: [],
});
const RECONCILE_FAILED_SINK = failureSink({
  event: "document_run.reconcile_failed",
  expected: [],
});

type DocumentRunLimits = {
  /**
   * Budget for the whole run, not for one model call: a long run is many
   * sequential calls that each carry their own timeout, and a budget sized for
   * one of them would abort the rest silently. Stays under `stuckRunningMs`,
   * which is what catches a worker that actually died.
   */
  readonly runTimeoutMs: number;
  /** A `running` row this long past its claim lost its worker. */
  readonly stuckRunningMs: number;
  /** A `queued` row this old lost its job; a younger one may be backlogged. */
  readonly stuckQueuedMs: number;
};

export const STANDARD_DOCUMENT_RUN_LIMITS = {
  runTimeoutMs: 15 * 60 * 1000,
  stuckRunningMs: 30 * 60 * 1000,
  stuckQueuedMs: DAY_IN_MS,
} as const satisfies DocumentRunLimits;

/**
 * The ages past which a sweep fails an active row. A feature compares its
 * rows against the clock it reads in the sweep itself, so each cutoff is
 * visibly a clock reading rather than a value passed in.
 */
export type StuckRunAges = {
  /** A `running` row claimed longer ago than this is stuck. */
  readonly runningMs: number;
  /** A `queued` row created longer ago than this is stuck. */
  readonly queuedMs: number;
};

/** What a job carries: the run and the member it acts for. */
export type DocumentRunJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
  /** Set on a queue whose job shape has been versioned; the worker refuses a
   *  job of any other version. */
  contractVersion?: number;
};

export type EnqueueDocumentRunArgs<Kind extends SafeIdType> = {
  runId: SafeId<Kind>;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** A `queued` row as the queued sweep reads it, in (created, id) order. */
type DocumentRunQueuedRow<Kind extends SafeIdType> = {
  id: SafeId<Kind>;
  organizationId: SafeId<"organization">;
  requestedBy: string | null;
  workspaceId: SafeId<"workspace">;
};

type Actor<Kind extends SafeIdType> = RootRunActor<Kind>;

type DocumentRunExecuteArgs<Kind extends SafeIdType, Claimed, Context> = {
  actor: Actor<Kind>;
  admission: ModelDispatchAdmission;
  run: Claimed;
  context: Context;
  /** Starts the run's time budget. Call it once, where the run's own work
   *  begins, and hand the signal to every model call. */
  deadline: () => AbortSignal;
};

/** Null on success, else the code the run failed with. */
export type DocumentRunExecute<
  Kind extends SafeIdType,
  Claimed,
  ErrorCode extends string,
  Context,
> = (
  args: DocumentRunExecuteArgs<Kind, Claimed, Context>,
) => Promise<ErrorCode | null>;

/** The code every queue fails a run with when nothing more specific is known:
 *  a thrown execution, a job BullMQ itself failed, a stuck row. */
const DOCUMENT_RUN_INTERNAL_ERROR = "internal";

type DocumentRunQueueSpec<
  Name extends BullMqQueueName,
  Kind extends SafeIdType,
  Claimed,
  ErrorCode extends string,
  Context,
  Db,
  Row extends DocumentRunQueuedRow<Kind>,
> = {
  name: Name;
  jobName: string;
  contractVersion?: number;
  /** The background slot a job takes; its period action was drawn when the
   *  run was queued. */
  actionKind: ConcurrencyOnlyActionKind;
  limits: DocumentRunLimits;
  /** The context a worker runs with; a caller of `processRun` or a sweep may
   *  pass its own. */
  workerContext: Context;
  /** The member the job acts for, from the job's data. */
  actor: (data: DocumentRunJobData) => Actor<Kind>;
  /**
   * The conditional `queued -> running` transition, with whatever the feature
   * settles first. Null when this delivery has nothing to do: a re-delivered
   * job, a terminal or deleted run, or one the feature closed itself.
   */
  claim: (args: {
    actor: Actor<Kind>;
    context: Context;
  }) => Promise<Claimed | null>;
  execute: DocumentRunExecute<Kind, Claimed, ErrorCode, Context>;
  /** The terminal `failed` transition. */
  fail: (args: {
    actor: Actor<Kind>;
    errorCode: ErrorCode | typeof DOCUMENT_RUN_INTERNAL_ERROR;
    context: Context;
  }) => Promise<void>;
  /** The code a thrown execution fails the run with; `internal` by default. */
  thrownErrorCode?: (
    error: unknown,
  ) => ErrorCode | typeof DOCUMENT_RUN_INTERNAL_ERROR;
  /** The next page of runs the queued sweep may hand back, after `cursor`. */
  readQueuedPage: (db: Db, cursor: Row | null) => Promise<readonly Row[]>;
  /** Whether a `queued` run may still be handed back; a run it refuses is
   *  closed by the feature. Absent, every attributed run is handed back. */
  admitQueued?: (args: {
    db: Db;
    run: Row;
    context: Context;
  }) => Promise<boolean>;
  /** Fail the feature's rows older than the stuck ages; returns how many. */
  failStuck: (args: {
    db: Db;
    stuck: StuckRunAges;
    context: Context;
  }) => Promise<number>;
};

class DocumentRunReconcileError extends TaggedError(
  "DocumentRunReconcileError",
)<{
  message: string;
  cause: unknown;
}> {}

type ProcessArgs<
  Kind extends SafeIdType,
  Claimed,
  ErrorCode extends string,
  Context,
> = {
  actor: Actor<Kind>;
  admission: ModelDispatchAdmission;
  context?: Context;
  /** Replaces the feature's execution, for a test that drives the skeleton. */
  execute?: DocumentRunExecute<Kind, Claimed, ErrorCode, Context>;
};

type ReconcileQueuedArgs<Db, Context> = {
  db: Db;
  queue?: RequeueableQueue<DocumentRunJobData>;
  context?: Context;
};

type ReconcileStuckArgs<Db, Context> = {
  db: Db;
  context?: Context;
};

type DocumentRunWorkerArgs<
  Name extends BullMqQueueName,
  Kind extends SafeIdType,
> = {
  name: Name;
  contractVersion: number | undefined;
  actionKind: ConcurrencyOnlyActionKind;
  actor: (data: DocumentRunJobData) => Actor<Kind>;
  processRun: (args: {
    actor: Actor<Kind>;
    admission: ModelDispatchAdmission;
  }) => Promise<void>;
  /** The last-resort `failed` write for a job BullMQ itself failed. */
  markFailed: (actor: Actor<Kind>) => Promise<void>;
};

/** Starts the queue's worker: concurrency 2, a background slot per job, and a
 *  last-resort failure write when the job fails outside the run. */
const startDocumentRunWorker = <
  Name extends BullMqQueueName,
  Kind extends SafeIdType,
>({
  name,
  contractVersion,
  actionKind,
  actor: actorFor,
  processRun,
  markFailed,
}: DocumentRunWorkerArgs<Name, Kind>) => {
  const worker = new BullMqWorker<DocumentRunJobData>(
    name,
    async (job) => {
      if (job.data.contractVersion !== contractVersion) {
        panic(`${name} received a job of another contract version`);
      }
      const actor = actorFor(job.data);
      // The run's period action was drawn when it was queued; the job takes
      // a background slot. The run bounds its own time.
      await runBackgroundJob({
        actionKind,
        organizationId: actor.organizationId,
        userId: actor.userId,
        organizationStateDb: actor.writeDb,
        job,
        signal: new AbortController().signal,
        run: async (_signal, admission) =>
          await processRun({ actor, admission }),
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
    // The job body already persists failures onto the row; this is the last
    // resort when the process threw before it could.
    if (job) {
      detached(
        async () =>
          await markFailed(actorFor(job.data)).catch((markError: unknown) => {
            observeFailure(markError, {
              sink: MARK_FAILED_SINK,
              ctx: {
                queue: name,
                runId: job.data.runId,
                workspaceId: job.data.workspaceId,
              },
            });
          }),
        "document-run.mark-run-failed",
      );
    }
    observeFailure(error, {
      sink: RUN_FAILED_SINK,
      ctx: {
        queue: name,
        ...(job
          ? { runId: job.data.runId, workspaceId: job.data.workspaceId }
          : {}),
      },
    });
  });

  worker.on(
    "error",
    createQueueWorkerErrorLogger("document_run.worker_error", {
      queue: name,
    }),
  );

  logger.info("document_run.worker_started", {
    queue: name,
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    queues: [name] as const,
    close: async () => {
      await worker.close();
    },
  };
};

export const createDocumentRunQueue = <
  Name extends BullMqQueueName,
  Kind extends SafeIdType,
  Claimed,
  ErrorCode extends string,
  Context,
  Db,
  Row extends DocumentRunQueuedRow<Kind>,
>(
  spec: DocumentRunQueueSpec<Name, Kind, Claimed, ErrorCode, Context, Db, Row>,
) => {
  const { name, limits, workerContext, contractVersion } = spec;
  if (limits.runTimeoutMs >= limits.stuckRunningMs) {
    panic(
      `${name}: a run's time budget must end before its row counts as stuck`,
    );
  }

  const getQueue = createLazyBullMqQueue<DocumentRunJobData>({
    name,
    defaultJobOptions: {
      attempts: JOB_ATTEMPTS,
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });

  /** One job, described exactly as the queue takes it. The run id is the job
   *  identity, so a duplicate enqueue collapses onto the job in flight. */
  const runJob = ({
    runId,
    workspaceId,
    organizationId,
    userId,
  }: EnqueueDocumentRunArgs<Kind>) => ({
    name: spec.jobName,
    data: {
      ...(contractVersion === undefined ? {} : { contractVersion }),
      runId,
      workspaceId,
      organizationId,
      userId,
    } satisfies DocumentRunJobData,
    opts: { jobId: createBullMqJobId(workspaceId, runId) },
  });

  const enqueue = async (args: EnqueueDocumentRunArgs<Kind>): Promise<void> => {
    const { name: jobName, data, opts } = runJob(args);
    await getQueue().add(jobName, data, opts);
  };

  /** Many runs in one round trip: the same jobs, under the same ids. */
  const enqueueMany = async (
    runs: readonly EnqueueDocumentRunArgs<Kind>[],
  ): Promise<void> => {
    if (runs.length === 0) {
      return;
    }
    await getQueue().addBulk(runs.map(runJob));
  };

  const thrownErrorCode =
    spec.thrownErrorCode ?? (() => DOCUMENT_RUN_INTERNAL_ERROR);

  /**
   * Claim the run, execute it, and own its failure write, so the failure path
   * is the same whether the execution returned a code or threw. A success is
   * the execution's own terminal write.
   */
  const processRun = async ({
    actor,
    admission,
    context = workerContext,
    execute = spec.execute,
  }: ProcessArgs<Kind, Claimed, ErrorCode, Context>): Promise<void> => {
    const claimed = await spec.claim({ actor, context });
    if (claimed === null) {
      return;
    }
    const outcome = await Result.tryPromise({
      try: async () =>
        await execute({
          actor,
          admission,
          run: claimed,
          context,
          deadline: () => AbortSignal.timeout(limits.runTimeoutMs),
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(outcome)) {
      observeFailure(outcome.error, {
        sink: RUN_FAILED_SINK,
        ctx: {
          queue: name,
          runId: actor.runId,
          workspaceId: actor.workspaceId,
        },
      });
      await spec.fail({
        actor,
        errorCode: thrownErrorCode(outcome.error),
        context,
      });
      return;
    }
    if (outcome.value !== null) {
      await spec.fail({ actor, errorCode: outcome.value, context });
    }
  };

  const reconcileQueued = async ({
    db,
    queue = getQueue(),
    context = workerContext,
  }: ReconcileQueuedArgs<Db, Context>): Promise<
    Result<ReconcileQueuedRunsResult, DocumentRunReconcileError>
  > => {
    const { admitQueued } = spec;
    return await Result.tryPromise({
      try: async () =>
        await reconcileQueuedRuns({
          queue,
          readPage: async (cursor: Row | null) =>
            await spec.readQueuedPage(db, cursor),
          runJob,
          ...(admitQueued === undefined
            ? {}
            : {
                admit: async (run: Row) =>
                  await admitQueued({ db, run, context }),
              }),
        }),
      catch: (cause) => {
        observeFailure(cause, {
          sink: RECONCILE_FAILED_SINK,
          ctx: { queue: name },
        });
        return new DocumentRunReconcileError({
          message: `${name} reconciliation failed`,
          cause,
        });
      },
    });
  };

  const reconcileStuck = async ({
    db,
    context = workerContext,
  }: ReconcileStuckArgs<Db, Context>): Promise<number> =>
    await spec.failStuck({
      db,
      context,
      stuck: {
        runningMs: limits.stuckRunningMs,
        queuedMs: limits.stuckQueuedMs,
      },
    });

  const initWorker = () =>
    startDocumentRunWorker({
      name,
      contractVersion,
      actionKind: spec.actionKind,
      actor: spec.actor,
      processRun,
      markFailed: async (actor) =>
        await spec.fail({
          actor,
          errorCode: DOCUMENT_RUN_INTERNAL_ERROR,
          context: workerContext,
        }),
    });

  return {
    name,
    limits,
    enqueue,
    enqueueMany,
    processRun,
    reconcileQueued,
    reconcileStuck,
    initWorker,
  };
};
