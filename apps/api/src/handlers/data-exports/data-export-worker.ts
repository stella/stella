/**
 * Background worker for organisation data exports.
 *
 * Exports are low-priority work that must never degrade the app for anyone
 * else, so the worker is deliberately small:
 * - its own queue, one job per API process and a small global cap across
 *   all processes; one active export per organisation (database index);
 * - paced reads (`pacer.ts`): short pauses always, long ones while the
 *   process has interactive work waiting;
 * - short transactions only: progress and checkpoints are separate tiny
 *   updates, and every read is a bounded page;
 * - resumable: the part plan is stored on the first attempt and each
 *   finished part is checkpointed, so a deploy, restart or failure resumes
 *   at the part it was in instead of starting over.
 *
 * It never deletes what it wrote: objects under `exports/` are removed by
 * the bucket lifecycle (see `lib/data-export/queue.ts`).
 */
import { TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  DATA_EXPORT_MAX_FAILURES,
  organizationDataExports,
} from "@/api/db/schema";
import type {
  DataExportPartRecord,
  DataExportPlanRecord,
} from "@/api/db/schema";
import {
  admitDataExportRecords,
  buildDataExport,
  DATA_EXPORT_RECORD_BYTES_CAP,
  planDataExport,
} from "@/api/handlers/data-exports/build-export";
import type {
  ExportProgress,
  ExportSink,
  ExportSource,
} from "@/api/handlers/data-exports/build-export";
import { createExportSource } from "@/api/handlers/data-exports/export-source";
import { createExportPacer } from "@/api/handlers/data-exports/pacer";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import {
  DATA_EXPORT_GLOBAL_CONCURRENCY,
  DATA_EXPORT_MANIFEST_FILE_NAME,
  DATA_EXPORT_PART_TARGET_BYTES,
  DATA_EXPORT_QUEUE_NAME,
  DATA_EXPORT_RETENTION_MS,
  dataExportObjectKey,
  dataExportPrefix,
  getDataExportQueue,
} from "@/api/lib/data-export/queue";
import type { DataExportJobData } from "@/api/lib/data-export/queue";
import { lockMemberAccessRow } from "@/api/lib/db/aggregate-lock";
import { DATA_EXPORT_TRANSITIONS } from "@/api/lib/db/data-export-transition-spec";
import { transition } from "@/api/lib/db/transitions";
import { isMemberRole } from "@/api/lib/member-roles";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { openS3StreamingUpload, writeS3ObjectWithRetry } from "@/api/lib/s3";
import { multipartPartBytes } from "@/api/lib/s3/multipart-sink";
import { brandPersistedDataExportId } from "@/api/lib/safe-id-boundaries";

const dataExportHeartbeatFailed = failureSink({
  event: "data_export.heartbeat",
  expected: [],
});
const dataExportAttemptFailed = failureSink({
  event: "data_export.attempt_failed",
  expected: [],
});
const dataExportGlobalConcurrencyFailed = failureSink({
  event: "data_export.global_concurrency",
  expected: [],
});

// One export per API process; the global cap bounds all processes together.
const WORKER_CONCURRENCY = 1;
const ERROR_MESSAGE_MAX_CHARS = 1000;
const ZIP_CONTENT_TYPE = "application/zip";
const JSON_CONTENT_TYPE = "application/json";
// Well inside DATA_EXPORT_HEARTBEAT_STALE_MS.
const HEARTBEAT_INTERVAL_MS = 60_000;

/** Shown to the requester; internal causes stay in telemetry. */
export const DATA_EXPORT_FAILURE_MESSAGE = {
  notAuthorized:
    "The export was stopped because its requester is no longer an organization owner or admin.",
  failed: "The export could not be completed. Please start a new export.",
  partTooLarge:
    "A matter exceeds the bounded export stream size. Contact support to export it.",
  recordsTooLarge:
    "The organization has more records than one export can hold. Contact support to export it.",
} as const;

/** Where one attempt writes its parts and the export manifest. */
type DataExportAttemptStorage = {
  sink: ExportSink;
  writeManifest: (bytes: Uint8Array) => Promise<void>;
};

export type DataExportRunDependencies = {
  db: ScopedDb;
  source: ExportSource;
  /** Storage keyed by attempt, so attempts never write the same object. */
  storage: (attempt: number) => DataExportAttemptStorage;
  pace: () => Promise<void>;
  /** Aborted on shutdown; the run stops and is resumed later. */
  signal: AbortSignal;
  partTargetBytes: number;
  /** The most record text one export may carry. */
  recordBytesCap: number;
  now: () => Date;
};

type RunIds = {
  exportId: SafeId<"dataExport">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

export const DATA_EXPORT_RUN_OUTCOME = {
  READY: "ready",
  FAILED: "failed",
  /** Stopped before finishing; queued again to resume from its checkpoint. */
  RESUMABLE: "resumable",
  SKIPPED: "skipped",
} as const;
export type DataExportRunOutcome =
  (typeof DATA_EXPORT_RUN_OUTCOME)[keyof typeof DATA_EXPORT_RUN_OUTCOME];

const ownRow = ({ exportId, organizationId }: RunIds) =>
  and(
    eq(organizationDataExports.id, exportId),
    eq(organizationDataExports.organizationId, organizationId),
  );

/**
 * Every write a run makes is fenced on the attempt it claimed: once the
 * maintenance sweep hands a stalled run to a new attempt, the old worker's
 * writes match nothing. Status changes go through DATA_EXPORT_TRANSITIONS,
 * which applies the same fence.
 */
const ownRun = (ids: RunIds, attempt: number) =>
  and(
    ownRow(ids),
    eq(organizationDataExports.status, "running"),
    eq(organizationDataExports.attempt, attempt),
  );

/** The requester lost the export permission while the run was going. */
class DataExportNotAuthorizedError extends TaggedError(
  "DataExportNotAuthorizedError",
)<{ message: string }> {}

/**
 * A newer attempt owns the run: a fenced write matched no row. The stale
 * worker stops without touching the row the newer attempt now drives.
 */
class DataExportSupersededError extends TaggedError(
  "DataExportSupersededError",
)<{ message: string }> {}

/** One part would exceed the largest object multipart upload can write. */
class DataExportPartTooLargeError extends TaggedError(
  "DataExportPartTooLargeError",
)<{ message: string }> {}

type RunTransaction = Parameters<Parameters<ScopedDb>[0]>[0];

const readAuthorized = async (
  tx: RunTransaction,
  { organizationId, userId }: RunIds,
): Promise<boolean> => {
  const requester = await lockMemberAccessRow({
    tx,
    organizationId,
    userId,
    mode: "share",
  });
  const role = requester?.role;
  return (
    role !== undefined &&
    isMemberRole(role) &&
    hasCurrentMemberPermission(role, { dataExport: ["create"] })
  );
};

/** Audits a status change of the run's export, in the change's transaction. */
const recordStatusChange =
  (ids: RunIds, metadata: Record<string, string | number>) =>
  async (
    tx: RunTransaction,
    row: { id: SafeId<"dataExport">; status: string },
  ) => {
    const record = createBackgroundAuditRecorder({
      execution: {
        performer: { id: "data-export", name: "Data export", type: "service" },
        trigger: {
          source: "action",
          type: "user_dispatch",
          userId: ids.userId,
        },
      },
      organizationId: ids.organizationId,
      workspaceId: null,
      userId: ids.userId,
    });
    await record(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DATA_EXPORT,
      resourceId: row.id,
      metadata: { status: row.status, ...metadata },
    });
  };

const markFailed = async (
  db: ScopedDb,
  ids: RunIds,
  attempt: number,
  message: string,
) => {
  await db(
    async (tx) =>
      await transition({
        tx,
        spec: DATA_EXPORT_TRANSITIONS,
        id: ids.exportId,
        options: {
          from: ["running"],
          to: "failed",
          fence: attempt,
          set: {
            error: message.slice(0, ERROR_MESSAGE_MAX_CHARS),
            completedAt: new Date(),
          },
        },
        recordTransitionAuditEvent: recordStatusChange(ids, { attempt }),
      }),
  );
};

/** Why a run handed itself back to the queue. */
const RESUME_REASON = {
  /** Graceful stop on deploy: not a failure, does not use up the budget. */
  GRACEFUL_STOP: "graceful_stop",
  FAILURE: "failure",
} as const;
type ResumeReason = (typeof RESUME_REASON)[keyof typeof RESUME_REASON];

/** Hand a stopped run back to the queue, keeping its plan and parts. */
const markResumable = async (
  db: ScopedDb,
  ids: RunIds,
  attempt: number,
  reason: ResumeReason,
) => {
  await db(
    async (tx) =>
      await transition({
        tx,
        spec: DATA_EXPORT_TRANSITIONS,
        id: ids.exportId,
        options: {
          from: ["running"],
          to: "queued",
          fence: attempt,
          set:
            reason === RESUME_REASON.FAILURE
              ? { failures: sql`${organizationDataExports.failures} + 1` }
              : {},
        },
        recordTransitionAuditEvent: recordStatusChange(ids, {
          attempt,
          reason,
        }),
      }),
  );
};

type MarkReadyArgs = {
  db: ScopedDb;
  ids: RunIds;
  attempt: number;
  values: {
    problemCount: number;
    mattersDone: number;
    bytesDone: number;
    completedAt: Date;
    expiresAt: Date;
  };
  audit: { parts: number; problems: number };
};

/**
 * Mark the export ready and audit it, only if `attempt` still owns the row.
 * Returns false when a newer attempt has taken over.
 */
const markReady = async ({
  db,
  ids,
  attempt,
  values,
  audit,
}: MarkReadyArgs): Promise<boolean> => {
  const moved = await db(async (tx) => {
    if (!(await readAuthorized(tx, ids))) {
      throw new DataExportNotAuthorizedError({
        message: DATA_EXPORT_FAILURE_MESSAGE.notAuthorized,
      });
    }
    return await transition({
      tx,
      spec: DATA_EXPORT_TRANSITIONS,
      id: ids.exportId,
      options: {
        from: ["running"],
        to: "ready",
        fence: attempt,
        set: { heartbeatAt: values.completedAt, ...values },
      },
      recordTransitionAuditEvent: recordStatusChange(ids, audit),
    });
  });
  // Stale: superseded by a newer attempt, which owns the row now.
  return moved.type === "transitioned";
};

type ClaimedRun = {
  createdAt: Date;
  startedAt: Date | null;
  versionScope: "all" | "current";
  plan: DataExportPlanRecord | null;
  parts: DataExportPartRecord[];
  attempt: number;
  failures: number;
};

type ClaimResult = {
  run: ClaimedRun | undefined;
  authorized: boolean;
  organizationName: string;
};

/** Move a queued export to running and advance its attempt fence. */
const claimRun = async (
  db: ScopedDb,
  ids: RunIds,
  now: Date,
): Promise<ClaimResult> =>
  await db(async (tx) => {
    const authorized = await readAuthorized(tx, ids);
    const orgRows = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, ids.organizationId));
    const organizationName = orgRows.at(0)?.name ?? "";
    const current = (
      await tx
        .select({ attempt: organizationDataExports.attempt })
        .from(organizationDataExports)
        // No row lock: the attempt fence below makes a concurrent claim of
        // the same export go stale.
        .where(and(ownRow(ids), eq(organizationDataExports.status, "queued")))
    ).at(0);
    if (current === undefined) {
      return { run: undefined, authorized, organizationName };
    }
    const attempt = current.attempt + 1;
    const moved = await transition({
      tx,
      spec: DATA_EXPORT_TRANSITIONS,
      id: ids.exportId,
      options: {
        from: ["queued"],
        to: "running",
        fence: current.attempt,
        nextFence: attempt,
        set: {
          startedAt: sql`COALESCE(${organizationDataExports.startedAt}, ${now})`,
          heartbeatAt: now,
        },
      },
      recordTransitionAuditEvent: recordStatusChange(ids, { attempt }),
    });
    if (moved.type === "stale") {
      return { run: undefined, authorized, organizationName };
    }
    const run = (
      await tx
        .select({
          createdAt: organizationDataExports.createdAt,
          startedAt: organizationDataExports.startedAt,
          versionScope: organizationDataExports.versionScope,
          plan: organizationDataExports.plan,
          parts: organizationDataExports.parts,
          attempt: organizationDataExports.attempt,
          failures: organizationDataExports.failures,
        })
        .from(organizationDataExports)
        .where(ownRun(ids, attempt))
    ).at(0);
    return { run, authorized, organizationName };
  });

type HeartbeatValues = {
  progress?: ExportProgress;
  plan?: DataExportPlanRecord;
  checkpoint?: DataExportPartRecord;
};

/**
 * Record liveness, and optionally progress, the plan or a finished part.
 * Fenced on the run's attempt; never changes the export's status.
 */
type WriteHeartbeatArgs = HeartbeatValues & {
  db: ScopedDb;
  ids: RunIds;
  attempt: number;
  now: Date;
};

const writeHeartbeat = async ({
  db,
  ids,
  attempt,
  progress,
  plan,
  checkpoint,
  now,
}: WriteHeartbeatArgs) => {
  const updated = await db(
    async (tx) =>
      // audit: skip - progress counters and checkpoints on an export whose status changes are audited
      await tx
        .update(organizationDataExports)
        .set({
          heartbeatAt: now,
          mattersDone: progress?.mattersDone,
          bytesDone: progress?.bytesDone,
          problemCount: progress?.problemCount,
          plan,
          mattersTotal: plan?.mattersTotal,
          bytesTotal: plan?.bytesTotal,
          partCount: plan?.parts.length,
          parts:
            checkpoint === undefined
              ? undefined
              : sql`${organizationDataExports.parts} || ${JSON.stringify([checkpoint])}::text::jsonb`,
        })
        .where(ownRun(ids, attempt))
        .returning({ id: organizationDataExports.id }),
  );
  if (updated.length === 0) {
    throw new DataExportSupersededError({
      message: "A newer attempt owns this export",
    });
  }
};

/**
 * Run one export attempt end to end. Exported for tests, which inject the
 * source, sink, storage and pacing; production wiring is in
 * `createS3RunDependencies`.
 */
export const runDataExport = async (
  ids: RunIds,
  deps: DataExportRunDependencies,
): Promise<DataExportRunOutcome> => {
  const { exportId, organizationId, userId } = ids;
  const now = deps.now();
  const claimed = await claimRun(deps.db, ids, now);
  if (claimed.run === undefined) {
    return DATA_EXPORT_RUN_OUTCOME.SKIPPED;
  }
  const run = claimed.run;
  // The read scope is the requester's live membership: a demoted admin
  // would silently export only part of the organisation. Refuse instead.
  if (!claimed.authorized) {
    await markFailed(
      deps.db,
      ids,
      run.attempt,
      DATA_EXPORT_FAILURE_MESSAGE.notAuthorized,
    );
    return DATA_EXPORT_RUN_OUTCOME.FAILED;
  }

  const heartbeat = async (values: HeartbeatValues) => {
    await writeHeartbeat({
      db: deps.db,
      ids,
      attempt: run.attempt,
      now: deps.now(),
      ...values,
    });
  };

  // Large files can keep one matter busy for a long time; a steady
  // heartbeat keeps the maintenance sweep from taking a live run for a lost
  // one.
  const closeHeartbeat = startNonOverlappingInterval({
    initialDelayMs: HEARTBEAT_INTERVAL_MS,
    intervalMs: HEARTBEAT_INTERVAL_MS,
    run: async () => {
      await heartbeat({});
    },
    onError: (error) => {
      // The run's next fenced write stops a superseded attempt.
      if (error instanceof DataExportSupersededError) {
        return;
      }
      observeFailure(error, {
        sink: dataExportHeartbeatFailed,
        ctx: { entityId: exportId, operation: "data_export.heartbeat" },
      });
    },
  });

  const storage = deps.storage(run.attempt);
  try {
    const scope = { versions: run.versionScope };
    // A resumed attempt keeps its stored plan but measures the records
    // again: they may have grown since the plan was made.
    const storedPlan = run.plan;
    const planned =
      storedPlan === null
        ? await planDataExport({
            source: deps.source,
            partTargetBytes: deps.partTargetBytes,
            recordBytesCap: deps.recordBytesCap,
            scope,
          })
        : (
            await admitDataExportRecords({
              source: deps.source,
              matterIds: storedPlan.parts.flatMap((part) => part.matterIds),
              recordBytesCap: deps.recordBytesCap,
            })
          ).map(() => storedPlan);
    // Retrying cannot shrink the records, so the export fails at once.
    if (planned.isErr()) {
      await markFailed(
        deps.db,
        ids,
        run.attempt,
        DATA_EXPORT_FAILURE_MESSAGE.recordsTooLarge,
      );
      return DATA_EXPORT_RUN_OUTCOME.FAILED;
    }
    const plan = planned.value;
    // Refuse before opening any upload: indivisible matters must fit the
    // provider's part count without increasing the stream buffer budget.
    if (
      plan.parts.some(
        (part) => multipartPartBytes(part.estimatedBytes) === null,
      )
    ) {
      throw new DataExportPartTooLargeError({
        message: DATA_EXPORT_FAILURE_MESSAGE.partTooLarge,
      });
    }
    if (run.plan === null) {
      await heartbeat({ plan });
    }
    const manifest = await buildDataExport({
      exportId,
      organization: { id: organizationId, name: claimed.organizationName },
      requestedBy: userId,
      createdAt: run.createdAt,
      scope,
      plan,
      // The manifest lists parts without the attempt that stored them.
      completedParts: run.parts.map(({ attempt: _attempt, ...part }) => part),
      source: deps.source,
      sink: storage.sink,
      pace: deps.pace,
      signal: deps.signal,
      // Each part re-checks the permission, so a requester demoted mid-run
      // stops the export instead of silently narrowing what it reads.
      beforePart: async () => {
        const authorized = await deps.db(
          async (tx) => await readAuthorized(tx, ids),
        );
        if (!authorized) {
          throw new DataExportNotAuthorizedError({
            message: DATA_EXPORT_FAILURE_MESSAGE.notAuthorized,
          });
        }
      },
      onProgress: async (progress: ExportProgress) => {
        await heartbeat({ progress });
      },
      onPartComplete: async (part) => {
        await heartbeat({ checkpoint: { ...part, attempt: run.attempt } });
      },
      now: deps.now,
    });
    await storage.writeManifest(
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    const completedAt = deps.now();
    // Counted from the first attempt: every object is younger than that, so
    // the bucket's own expiry of the same age never removes a file still
    // offered.
    const firstStart = run.startedAt ?? now;
    const finished = await markReady({
      db: deps.db,
      ids,
      attempt: run.attempt,
      values: {
        problemCount: manifest.problems.length,
        mattersDone: plan.mattersTotal,
        bytesDone: plan.bytesTotal,
        completedAt,
        expiresAt: new Date(firstStart.getTime() + DATA_EXPORT_RETENTION_MS),
      },
      audit: {
        parts: manifest.parts.length,
        problems: manifest.problems.length,
      },
    });
    return finished
      ? DATA_EXPORT_RUN_OUTCOME.READY
      : DATA_EXPORT_RUN_OUTCOME.SKIPPED;
  } catch (error) {
    // Boundary of a background job: every failure ends in a row state,
    // except a superseded attempt, whose row the newer attempt owns.
    if (error instanceof DataExportSupersededError) {
      return DATA_EXPORT_RUN_OUTCOME.SKIPPED;
    }
    if (error instanceof DataExportNotAuthorizedError) {
      await markFailed(deps.db, ids, run.attempt, error.message);
      return DATA_EXPORT_RUN_OUTCOME.FAILED;
    }
    if (error instanceof DataExportPartTooLargeError) {
      await markFailed(deps.db, ids, run.attempt, error.message);
      return DATA_EXPORT_RUN_OUTCOME.FAILED;
    }

    if (deps.signal.aborted) {
      await markResumable(
        deps.db,
        ids,
        run.attempt,
        RESUME_REASON.GRACEFUL_STOP,
      );
      return DATA_EXPORT_RUN_OUTCOME.RESUMABLE;
    }
    observeFailure(error, {
      sink: dataExportAttemptFailed,
      ctx: {
        entityId: exportId,
        organizationId,
        operation: "data_export.attempt",
        step: `attempt-${run.attempt}`,
      },
    });
    if (run.failures + 1 < DATA_EXPORT_MAX_FAILURES) {
      await markResumable(deps.db, ids, run.attempt, RESUME_REASON.FAILURE);
      return DATA_EXPORT_RUN_OUTCOME.RESUMABLE;
    }
    // Parts already written stay until the bucket lifecycle expires them;
    // a failed export never offers a download link for them.
    await markFailed(
      deps.db,
      ids,
      run.attempt,
      DATA_EXPORT_FAILURE_MESSAGE.failed,
    );
    return DATA_EXPORT_RUN_OUTCOME.FAILED;
  } finally {
    await closeHeartbeat();
  }
};

type S3DependenciesArgs = RunIds & {
  db: ScopedDb;
  signal: AbortSignal;
  pace: () => Promise<void>;
};

/** Production wiring: membership-scoped paged reads, multipart uploads. */
const createS3RunDependencies = ({
  exportId,
  organizationId,
  db,
  signal,
  pace,
}: S3DependenciesArgs): DataExportRunDependencies => {
  const prefix = dataExportPrefix({ organizationId, exportId });
  return {
    db,
    source: createExportSource({ db, organizationId, signal, pace }),
    storage: (attempt) => ({
      sink: {
        openPart: (fileName, estimatedBytes) => {
          // Keep the same fixed buffer budget when opening each admitted part.
          const partBytes = multipartPartBytes(estimatedBytes);
          if (partBytes === null) {
            throw new DataExportPartTooLargeError({
              message: DATA_EXPORT_FAILURE_MESSAGE.partTooLarge,
            });
          }
          // An unfinished multipart upload is aborted by the bucket lifecycle.
          const upload = openS3StreamingUpload({
            key: dataExportObjectKey({
              organizationId,
              exportId,
              attempt,
              fileName,
            }),
            contentType: ZIP_CONTENT_TYPE,
            partBytes,
            ownership: { type: "lifecycle-prefix", prefix },
          });
          return { write: upload.write, close: upload.end };
        },
      },
      writeManifest: async (bytes) => {
        await writeS3ObjectWithRetry(
          {
            key: dataExportObjectKey({
              organizationId,
              exportId,
              attempt,
              fileName: DATA_EXPORT_MANIFEST_FILE_NAME,
            }),
            data: bytes,
            contentType: JSON_CONTENT_TYPE,
            signal,
          },
          { type: "lifecycle-prefix", prefix },
        );
      },
    }),
    pace,
    signal,
    partTargetBytes: DATA_EXPORT_PART_TARGET_BYTES,
    recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
    now: () => new Date(),
  };
};

export const initDataExportWorker = (_context: BullMqWorkerContext) => {
  // Aborted on shutdown so a running export checkpoints out promptly and a
  // later process resumes it.
  const shutdown = new AbortController();
  const worker = new BullMqWorker<DataExportJobData>(
    DATA_EXPORT_QUEUE_NAME,
    async (job) => {
      // A member run with no matter pinned: every read, and the export's
      // own row, goes through the requester's membership as it stands when
      // each transaction runs, so revoked access reads nothing.
      const actor = createRootRunActor(
        {
          organizationId: job.data.organizationId,
          workspaceId: null,
          userId: job.data.userId,
          runId: job.data.exportId,
        },
        brandPersistedDataExportId,
      );
      const ids = {
        exportId: actor.runId,
        organizationId: actor.organizationId,
        userId: actor.userId,
      };
      const db = actor.inputDb;
      const pacer = createExportPacer();
      try {
        const outcome = await runDataExport(
          ids,
          createS3RunDependencies({
            ...ids,
            db,
            signal: shutdown.signal,
            pace: pacer.pace,
          }),
        );
        logger.info("data_export.attempt_finished", {
          exportId: ids.exportId,
          outcome,
        });
      } finally {
        pacer.close();
      }
    },
    {
      connection: createBullMqConnection({
        storeClass: "durable-coordination",
      }),
      concurrency: WORKER_CONCURRENCY,
    },
  );
  // A queue-wide cap across every API process, so exports for many
  // organisations never take more than a sliver of storage and database.
  getDataExportQueue()
    .setGlobalConcurrency(DATA_EXPORT_GLOBAL_CONCURRENCY)
    .catch((error: unknown) => {
      observeFailure(error, {
        sink: dataExportGlobalConcurrencyFailed,
        ctx: { operation: "data_export.global_concurrency" },
      });
    });
  worker.on("error", createQueueWorkerErrorLogger("data_export.worker_error"));
  logger.info("data_export.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });
  return {
    queues: [DATA_EXPORT_QUEUE_NAME] as const,
    close: async () => {
      shutdown.abort();
      await worker.close();
    },
  };
};
