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
 * the bucket lifecycle (see `data-export-queue.ts`).
 */
import { TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { member, organization } from "@/api/db/auth-schema";
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
  buildDataExport,
  planDataExport,
} from "@/api/handlers/data-exports/build-export";
import type {
  ExportProgress,
  ExportSink,
  ExportSource,
} from "@/api/handlers/data-exports/build-export";
import { createExportSource } from "@/api/handlers/data-exports/export-source";
import { createExportPacer } from "@/api/handlers/data-exports/pacer";
import { captureError } from "@/api/lib/analytics/capture";
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
  dataExportPartKey,
  dataExportPrefix,
  getDataExportQueue,
} from "@/api/lib/data-export-queue";
import type { DataExportJobData } from "@/api/lib/data-export-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { isMemberRole } from "@/api/lib/member-roles";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { logger } from "@/api/lib/observability/logger";
import { hasCurrentMemberPermission } from "@/api/lib/permission-authorization";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import {
  multipartPartBytes,
  openS3StreamingUpload,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import {
  brandPersistedDataExportId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

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
    "A matter is larger than one export part can hold. Contact support to export it.",
} as const;

export type DataExportRunDependencies = {
  db: ScopedDb;
  source: ExportSource;
  sink: ExportSink;
  /** Store the export manifest next to the parts. */
  writeManifest: (bytes: Uint8Array) => Promise<void>;
  pace: () => Promise<void>;
  /** Aborted on shutdown; the run stops and is resumed later. */
  signal: AbortSignal;
  partTargetBytes: number;
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
 * writes match nothing.
 */
const ownRun = (ids: RunIds, attempt: number) =>
  and(
    ownRow(ids),
    eq(organizationDataExports.status, "running"),
    eq(organizationDataExports.attempts, attempt),
  );

/** The requester lost the export permission while the run was going. */
export class DataExportNotAuthorizedError extends TaggedError(
  "DataExportNotAuthorizedError",
)<{ message: string }> {}

/** One part would exceed the largest object multipart upload can write. */
export class DataExportPartTooLargeError extends TaggedError(
  "DataExportPartTooLargeError",
)<{ message: string }> {}

const readAuthorized = async (
  tx: Parameters<Parameters<ScopedDb>[0]>[0],
  { organizationId, userId }: RunIds,
): Promise<boolean> => {
  const roles = await tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    );
  const role = roles.at(0)?.role;
  return (
    role !== undefined &&
    isMemberRole(role) &&
    hasCurrentMemberPermission(role, { dataExport: ["create"] })
  );
};

const markFailed = async (
  db: ScopedDb,
  ids: RunIds,
  attempt: number,
  message: string,
) => {
  await db(async (tx) => {
    // audit: skip - terminal bookkeeping on an export whose request is audited
    await tx
      .update(organizationDataExports)
      .set({
        status: "failed",
        error: message.slice(0, ERROR_MESSAGE_MAX_CHARS),
        completedAt: new Date(),
      })
      .where(ownRun(ids, attempt));
  });
};

/** Why a run handed itself back to the queue. */
const RESUME_REASON = {
  /** Graceful shutdown: not a failure, does not use up the budget. */
  SHUTDOWN: "shutdown",
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
  await db(async (tx) => {
    // audit: skip - lifecycle transition of an audited export request
    await tx
      .update(organizationDataExports)
      .set({
        status: "queued",
        failures:
          reason === RESUME_REASON.FAILURE
            ? sql`${organizationDataExports.failures} + 1`
            : organizationDataExports.failures,
      })
      .where(ownRun(ids, attempt));
  });
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
  const recordAuditEvent = createBackgroundAuditRecorder({
    execution: {
      performer: { id: "data-export", name: "Data export", type: "service" },
      trigger: { source: "action", type: "user_dispatch", userId: ids.userId },
    },
    organizationId: ids.organizationId,
    workspaceId: null,
    userId: ids.userId,
  });
  return await db(async (tx) => {
    const updated = await tx
      .update(organizationDataExports)
      .set({ status: "ready", heartbeatAt: values.completedAt, ...values })
      .where(ownRun(ids, attempt))
      .returning({ id: organizationDataExports.id });
    // Superseded by a newer attempt: that attempt owns the row now.
    if (updated.length === 0) {
      return false;
    }
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DATA_EXPORT,
      resourceId: ids.exportId,
      metadata: { status: "ready", ...audit },
    });
    return true;
  });
};

type ClaimedRun = {
  createdAt: Date;
  startedAt: Date | null;
  versionScope: "all" | "current";
  plan: DataExportPlanRecord | null;
  parts: DataExportPartRecord[];
  attempts: number;
  failures: number;
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
  const claimed = await deps.db(async (tx) => {
    const authorized = await readAuthorized(tx, ids);
    // audit: skip - lifecycle transition of an audited export request
    const rows = await tx
      .update(organizationDataExports)
      .set({
        status: "running",
        attempts: sql`${organizationDataExports.attempts} + 1`,
        startedAt: sql`COALESCE(${organizationDataExports.startedAt}, ${now})`,
        heartbeatAt: now,
      })
      .where(and(ownRow(ids), eq(organizationDataExports.status, "queued")))
      .returning({
        createdAt: organizationDataExports.createdAt,
        startedAt: organizationDataExports.startedAt,
        versionScope: organizationDataExports.versionScope,
        plan: organizationDataExports.plan,
        parts: organizationDataExports.parts,
        attempts: organizationDataExports.attempts,
        failures: organizationDataExports.failures,
      });
    const orgRows = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId));
    return {
      row: rows.at(0),
      authorized,
      organizationName: orgRows.at(0)?.name ?? "",
    };
  });
  if (claimed.row === undefined) {
    return DATA_EXPORT_RUN_OUTCOME.SKIPPED;
  }
  const run: ClaimedRun = claimed.row;
  // The read scope is the requester's live membership: a demoted admin
  // would silently export only part of the organisation. Refuse instead.
  if (!claimed.authorized) {
    await markFailed(
      deps.db,
      ids,
      run.attempts,
      DATA_EXPORT_FAILURE_MESSAGE.notAuthorized,
    );
    return DATA_EXPORT_RUN_OUTCOME.FAILED;
  }

  const heartbeat = async (
    values: Partial<typeof organizationDataExports.$inferInsert>,
  ) => {
    await deps.db(async (tx) => {
      // audit: skip - progress counters and checkpoints on an audited export
      await tx
        .update(organizationDataExports)
        .set({ ...values, heartbeatAt: deps.now() })
        .where(ownRun(ids, run.attempts));
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
      captureError(error, { exportId, operation: "data_export.heartbeat" });
    },
  });

  try {
    const scope = { versions: run.versionScope };
    const plan =
      run.plan ??
      (await planDataExport({
        source: deps.source,
        partTargetBytes: deps.partTargetBytes,
        scope,
      }));
    if (run.plan === null) {
      await heartbeat({
        plan,
        mattersTotal: plan.mattersTotal,
        bytesTotal: plan.bytesTotal,
        partCount: plan.parts.length,
      });
    }
    const manifest = await buildDataExport({
      exportId,
      organization: { id: organizationId, name: claimed.organizationName },
      requestedBy: userId,
      createdAt: run.createdAt,
      scope,
      plan,
      completedParts: run.parts,
      source: deps.source,
      sink: deps.sink,
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
        await heartbeat({
          mattersDone: progress.mattersDone,
          bytesDone: progress.bytesDone,
          problemCount: progress.problemCount,
        });
      },
      onPartComplete: async (part) => {
        const checkpoint: DataExportPartRecord = part;
        await heartbeat({
          parts: sql`${organizationDataExports.parts} || ${JSON.stringify([checkpoint])}::text::jsonb`,
        });
      },
      now: deps.now,
    });
    await deps.writeManifest(
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
      attempt: run.attempts,
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
    // Boundary of a background job: every failure ends in a row state.
    if (error instanceof DataExportNotAuthorizedError) {
      await markFailed(deps.db, ids, run.attempts, error.message);
      return DATA_EXPORT_RUN_OUTCOME.FAILED;
    }
    if (error instanceof DataExportPartTooLargeError) {
      await markFailed(deps.db, ids, run.attempts, error.message);
      return DATA_EXPORT_RUN_OUTCOME.FAILED;
    }
    if (deps.signal.aborted) {
      await markResumable(deps.db, ids, run.attempts, RESUME_REASON.SHUTDOWN);
      return DATA_EXPORT_RUN_OUTCOME.RESUMABLE;
    }
    captureError(error, { exportId, organizationId });
    logger.error("data_export.attempt_failed", {
      exportId,
      attempt: String(run.attempts),
      "error.type": errorTag(error),
    });
    if (run.failures + 1 < DATA_EXPORT_MAX_FAILURES) {
      await markResumable(deps.db, ids, run.attempts, RESUME_REASON.FAILURE);
      return DATA_EXPORT_RUN_OUTCOME.RESUMABLE;
    }
    // Parts already written stay until the bucket lifecycle expires them;
    // a failed export never offers a download link for them.
    await markFailed(
      deps.db,
      ids,
      run.attempts,
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
export const createS3RunDependencies = ({
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
    sink: {
      openPart: (fileName, estimatedBytes) => {
        // A matter is never split, so one huge matter makes one huge part:
        // size the upload parts for it, and stop with a clear message when
        // even the largest parts cannot hold it.
        const partBytes = multipartPartBytes(estimatedBytes);
        if (partBytes === null) {
          throw new DataExportPartTooLargeError({
            message: DATA_EXPORT_FAILURE_MESSAGE.partTooLarge,
          });
        }
        // Part keys are deterministic: a part rebuilt by a resumed attempt
        // overwrites the earlier object, and an unfinished multipart upload
        // is aborted by the bucket lifecycle.
        const upload = openS3StreamingUpload({
          key: dataExportPartKey({ organizationId, exportId, fileName }),
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
          key: dataExportPartKey({
            organizationId,
            exportId,
            fileName: DATA_EXPORT_MANIFEST_FILE_NAME,
          }),
          data: bytes,
          contentType: JSON_CONTENT_TYPE,
          signal,
        },
        { type: "lifecycle-prefix", prefix },
      );
    },
    pace,
    signal,
    partTargetBytes: DATA_EXPORT_PART_TARGET_BYTES,
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
      const ids = {
        exportId: brandPersistedDataExportId(job.data.exportId),
        organizationId: brandPersistedOrganizationId(job.data.organizationId),
        userId: brandPersistedUserId(job.data.userId),
      };
      const db = createRootMembershipScopedDb({
        organizationId: ids.organizationId,
        userId: ids.userId,
      });
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
      captureError(error, { operation: "data_export.global_concurrency" });
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
