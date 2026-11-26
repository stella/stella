import { panic, Result } from "better-result";
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES } from "@stll/api-contract/recording-transcription";
import type { RecordingTranscriptionRunErrorCode } from "@stll/api-contract/recording-transcription";
import { workspaceIsVisible } from "@stll/api-contract/workspace-status";
import { transcriptDocx } from "@stll/docx-authoring/transcript";
import type { TranscriptParagraph } from "@stll/docx-authoring/transcript";
import type { PermissionInput } from "@stll/permissions";
import type { RecordingRefusal } from "@stll/recording-wasm";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { recordingTranscriptionRuns } from "@/api/db/schema";
import {
  DEFAULT_DICTATION_DEPENDENCIES,
  type DictationCaller,
  executeDictation,
} from "@/api/handlers/dictation/transcribe";
import { loadOrgSettingsForAuth } from "@/api/lib/ai-config-loader";
import { detached } from "@/api/lib/analytics/capture";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  hasCurrentActiveWorkspaceMemberPermission,
  requireCurrentActiveWorkspaceMemberPermission,
} from "@/api/lib/db/member-authority";
import { transition, transitionBatch } from "@/api/lib/db/transitions";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import {
  readEntityVersionFile,
  resolveEntityVersionFile,
} from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { startNonOverlappingInterval } from "@/api/lib/non-overlapping-interval";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  reconcileQueuedRuns,
} from "@/api/lib/queue-reconcile-scan";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { runBackgroundJob } from "@/api/lib/rate-limit/queued-action-admission";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedRecordingTranscriptionRunId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { openRecordingReader } from "./recording-reader";
import { RECORDING_TRANSCRIPTION_TRANSITIONS } from "./transitions";

const QUEUE_NAME = "recording-transcriptions";

const runFailure = failureSink({
  event: "recording_transcription.run_failed",
  expected: [],
});

const reconcileFailure = failureSink({
  event: "recording_transcription.reconcile_failed",
  expected: [],
});
const JOB_NAME = "run-recording-transcription";
const WORKER_CONCURRENCY = 2;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;
const ORPHAN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_RUNNING_MS = 3 * 60 * 60 * 1000;

type RecordingTranscriptionRunJobData = {
  runId: string;
  workspaceId: string;
  organizationId: string;
  userId: string;
};

export type EnqueueRecordingTranscriptionRunArgs = {
  runId: SafeId<"recordingTranscriptionRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const getQueue = createLazyBullMqQueue<RecordingTranscriptionRunJobData>({
  name: QUEUE_NAME,
  connectionOptions: {
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  },
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/** One job, described exactly as the queue takes it; the run id is the job
 *  identity, so a repeated enqueue collapses onto the job in flight. */
const runJob = ({
  runId,
  workspaceId,
  organizationId,
  userId,
}: EnqueueRecordingTranscriptionRunArgs) => ({
  name: JOB_NAME,
  data: { runId, workspaceId, organizationId, userId },
  opts: { jobId: createBullMqJobId(workspaceId, runId) },
});

export const enqueueRecordingTranscriptionRun = async (
  args: EnqueueRecordingTranscriptionRunArgs,
): Promise<void> => {
  const { data, name, opts } = runJob(args);
  await requeueDeterministicJob({
    data,
    jobId: opts.jobId,
    name,
    queue: getQueue(),
  });
};

type RunActor = RootRunActor<"recordingTranscriptionRun">;

/** Transcribing sends the recording to a model; saving files a document. */
const RECORDING_TRANSCRIPTION_RUN_PERMISSIONS = {
  entity: ["create"],
  chat: ["create"],
} as const satisfies PermissionInput;

const requireRunAuthority = async (
  actor: RunActor,
  tx: Transaction,
): Promise<void> => {
  await requireCurrentActiveWorkspaceMemberPermission({
    db: tx,
    organizationId: actor.organizationId,
    userId: actor.userId,
    workspaceId: actor.workspaceId,
    permissions: RECORDING_TRANSCRIPTION_RUN_PERMISSIONS,
  });
};

const authorizedWrite = async <T>(
  actor: RunActor,
  write: (tx: Transaction) => T | Promise<T>,
): Promise<T> =>
  await actor.writeDb(async (tx) => {
    await requireRunAuthority(actor, tx);
    return await write(tx);
  });

const brandActor = (data: RecordingTranscriptionRunJobData): RunActor =>
  createRootRunActor(data, brandPersistedRecordingTranscriptionRunId);

type ClaimedRun = {
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  sourceFileId: SafeId<"userFile">;
  sourceFileName: string;
  sourceMimeType: string;
};

const RUN_AUTHORITY_REVOKED = "authority_revoked" as const;

const unaudited = async () => await Promise.resolve();

const claimRun = async (
  actor: RunActor,
): Promise<ClaimedRun | typeof RUN_AUTHORITY_REVOKED | null> =>
  await actor.writeDb(async (tx) => {
    // The run was audited when it was started; its stages are bookkeeping.
    const claimed = await transition({
      tx,
      spec: RECORDING_TRANSCRIPTION_TRANSITIONS,
      id: actor.runId,
      options: {
        from: ["queued"],
        to: "transcribing",
        set: { startedAt: new Date() },
      },
      recordTransitionAuditEvent: unaudited,
    });
    if (claimed.type === "stale") {
      return null;
    }
    const authorized = await hasCurrentActiveWorkspaceMemberPermission({
      db: tx,
      organizationId: actor.organizationId,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      permissions: RECORDING_TRANSCRIPTION_RUN_PERMISSIONS,
    });
    if (!authorized) {
      return RUN_AUTHORITY_REVOKED;
    }
    const [row] = await tx
      .select({
        entityId: recordingTranscriptionRuns.entityId,
        fileFieldId: recordingTranscriptionRuns.fileFieldId,
        entityVersionId: recordingTranscriptionRuns.entityVersionId,
        sourceFileId: recordingTranscriptionRuns.sourceFileId,
        sourceFileName: recordingTranscriptionRuns.sourceFileName,
        sourceMimeType: recordingTranscriptionRuns.sourceMimeType,
      })
      .from(recordingTranscriptionRuns)
      .where(
        and(
          eq(recordingTranscriptionRuns.id, actor.runId),
          eq(recordingTranscriptionRuns.workspaceId, actor.workspaceId),
        ),
      );
    return row ?? null;
  });

const toSaving = async (actor: RunActor): Promise<boolean> =>
  await authorizedWrite(
    actor,
    async (tx) =>
      (
        await transition({
          tx,
          spec: RECORDING_TRANSCRIPTION_TRANSITIONS,
          id: actor.runId,
          options: { from: ["transcribing"], to: "saving" },
          recordTransitionAuditEvent: unaudited,
        })
      ).type === "transitioned",
  );

const setProgress = async (
  actor: RunActor,
  {
    durationMs,
    transcribedMs,
  }: { durationMs?: number | null; transcribedMs: number },
): Promise<void> => {
  await authorizedWrite(actor, async (tx) => {
    // audit: skip - progress bookkeeping on the run audited at create.
    // A run the reconciler already settled keeps the progress it settled with.
    await tx
      .update(recordingTranscriptionRuns)
      .set({ durationMs, transcribedMs })
      .where(
        and(
          eq(recordingTranscriptionRuns.id, actor.runId),
          inArray(recordingTranscriptionRuns.status, [
            ...RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES,
          ]),
        ),
      );
  });
};

/** Fails the run from whichever active stage it is in. */
const setRunFailed = async (
  actor: RunActor,
  errorCode: RecordingTranscriptionRunErrorCode,
): Promise<boolean> =>
  await actor.writeDb(
    async (tx) =>
      (
        await transition({
          tx,
          spec: RECORDING_TRANSCRIPTION_TRANSITIONS,
          id: actor.runId,
          options: {
            from: [...RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES],
            to: "failed",
            set: { errorCode, finishedAt: new Date() },
          },
          recordTransitionAuditEvent: unaudited,
        })
      ).type === "transitioned",
  );

const loadPinnedRecording = async (
  actor: RunActor,
  run: ClaimedRun,
): Promise<Result<ArrayBuffer, RecordingTranscriptionRunErrorCode>> => {
  const file = await resolveEntityVersionFile({
    safeDb: actor.inputSafeDb,
    workspaceId: actor.workspaceId,
    entityId: run.entityId,
    fileFieldId: run.fileFieldId,
    allowReadOnly: true,
  });
  if (Result.isError(file)) {
    return Result.err("document_unresolved");
  }
  if (
    file.value.entityVersionId !== run.entityVersionId ||
    file.value.fileId !== run.sourceFileId
  ) {
    return Result.err("document_changed");
  }
  const read = await readEntityVersionFile(file.value, actor.organizationId);
  return Result.isError(read)
    ? Result.err("document_unresolved")
    : Result.ok(read.value.bytes);
};

const REFUSAL_ERROR_CODES = {
  unsupported: "unsupported_format",
  unreadable: "unsupported_format",
  dictaphone: "unsupported_format",
  too_long: "too_long",
} as const satisfies Record<
  RecordingRefusal,
  RecordingTranscriptionRunErrorCode
>;

const transcriptionErrorCode = (
  error: unknown,
): RecordingTranscriptionRunErrorCode =>
  HandlerError.is(error) && error.status === 503
    ? "provider_unavailable"
    : "transcription_failed";

/** The member's caller for `executeDictation`, built from the run's actor
 *  the way the desktop endpoint builds one from its linked account. */
const dictationCaller = async (
  actor: RunActor,
): Promise<Result<DictationCaller, RecordingTranscriptionRunErrorCode>> => {
  const settings = await authorizedWrite(
    actor,
    async (tx) => await loadOrgSettingsForAuth(tx, actor),
  );
  const matter = await actor.inputDb(
    async (tx) =>
      (await tx.query.workspaces.findFirst({
        where: {
          id: { eq: actor.workspaceId },
          organizationId: { eq: actor.organizationId },
        },
        columns: { id: true, status: true },
      })) ?? null,
  );
  if (matter === null || !workspaceIsVisible(matter.status)) {
    return Result.err("document_unresolved");
  }
  return Result.ok({
    ...settings,
    user: { id: actor.userId },
    session: { activeOrganizationId: actor.organizationId },
    safeDb: actor.writeSafeDb,
    recordAuditEvent: createAuditRecorder({
      execution: {
        performer: {
          type: "service",
          id: `recording-transcription:${actor.runId}`,
          name: "Recording transcription",
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
      request: new Request("http://recording-transcription.internal/"),
      server: null,
    }),
    // Asked before each piece goes to the model, so a requester who loses
    // the matter mid-run stops the next piece rather than the next write.
    getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) => {
      if (workspaceId !== matter.id) {
        return null;
      }
      const authorized = await actor.writeDb(
        async (tx) =>
          await hasCurrentActiveWorkspaceMemberPermission({
            db: tx,
            organizationId: actor.organizationId,
            userId: actor.userId,
            workspaceId: actor.workspaceId,
            permissions: RECORDING_TRANSCRIPTION_RUN_PERMISSIONS,
          }),
      );
      return authorized ? matter : null;
    },
  });
};

const transcriptName = (sourceFileName: string): string =>
  `${sourceFileName.replace(/\.[^.]+$/u, "")} transcript`;

const executeRun = async ({
  actor,
  admission,
  run,
}: {
  actor: RunActor;
  admission: ModelDispatchAdmission;
  run: ClaimedRun;
}): Promise<RecordingTranscriptionRunErrorCode | null> => {
  const bytes = await loadPinnedRecording(actor, run);
  if (Result.isError(bytes)) {
    return bytes.error;
  }
  const caller = await dictationCaller(actor);
  if (Result.isError(caller)) {
    return caller.error;
  }
  const extension = /\.([^.]+)$/u.exec(run.sourceFileName)?.[1] ?? null;
  const reader = await openRecordingReader({ bytes: bytes.value, extension });
  if (Result.isError(reader)) {
    return REFUSAL_ERROR_CODES[reader.error];
  }
  const paragraphs: TranscriptParagraph[] = [];
  try {
    await setProgress(actor, {
      durationMs: reader.value.durationMs,
      transcribedMs: 0,
    });
    for (;;) {
      const read = await reader.value.next();
      if (Result.isError(read)) {
        return REFUSAL_ERROR_CODES[read.error];
      }
      const piece = read.value;
      if (piece === null) {
        break;
      }
      if (piece.speech) {
        // db-await-in-loop: one piece's audio in memory at a time, in order.
        const transcribed = await executeDictation(
          {
            ...caller.value,
            body: {
              file: new File([piece.wav], `piece-${piece.index}.wav`, {
                type: "audio/wav",
              }),
              matterId: actor.workspaceId,
            },
            request: new Request("http://recording-transcription.internal/"),
            modelAdmission: admission,
            usageKey: {
              idempotencyKey: `recording-transcription:${actor.runId}:${piece.index}`,
              resourceId: actor.runId,
            },
          },
          // The run was admitted once when it was queued; its pieces are
          // not member requests and do not spend the dictation request rate.
          {
            ...DEFAULT_DICTATION_DEPENDENCIES,
            limit: async () => await Promise.resolve(Result.ok()),
          },
        );
        if (Result.isError(transcribed)) {
          observeFailure(transcribed.error, { sink: runFailure });
          return transcriptionErrorCode(transcribed.error);
        }
        if (transcribed.value.text.trim().length > 0) {
          paragraphs.push({
            startMs: piece.startMs,
            text: transcribed.value.text,
          });
        }
      }
      // db-await-in-loop: one ordered progress write per piece.
      await setProgress(actor, { transcribedMs: piece.endMs });
    }
  } finally {
    await reader.value.close();
  }
  if (paragraphs.length === 0) {
    return "no_speech";
  }
  if (!(await toSaving(actor))) {
    return "internal";
  }
  const name = transcriptName(run.sourceFileName);
  const docx = await transcriptDocx({ title: name, paragraphs });
  if (Result.isError(docx)) {
    observeFailure(docx.error, { sink: runFailure });
    return "internal";
  }
  const source = await actor.inputDb(
    async (tx) =>
      (await tx.query.entities.findFirst({
        where: {
          id: { eq: run.entityId },
          workspaceId: { eq: actor.workspaceId },
        },
        columns: { parentId: true },
      })) ?? null,
  );
  const created = await createEntityFromBuffer({
    scopedDb: actor.writeDb,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    recordAuditEvent: caller.value.recordAuditEvent,
    buffer: docx.value,
    fileName: sanitizeFilenamePreservingExtension(`${name}.docx`),
    mimeType: DOCX_MIME_TYPE,
    encryption: serverBuiltFileEncryption(),
    parentId: source?.parentId ?? null,
    authority: {
      type: "current-member",
      authorize: async (tx) => {
        await requireRunAuthority(actor, tx);
      },
    },
    afterCreate: async (tx, output) => {
      // Committed with the audited transcript, so a saved transcript never
      // leaves a stuck run.
      const completed = await transition({
        tx,
        spec: RECORDING_TRANSCRIPTION_TRANSITIONS,
        id: actor.runId,
        options: {
          from: ["saving"],
          to: "completed",
          set: {
            errorCode: null,
            finishedAt: new Date(),
            outputEntityId: output.entityId,
            outputFieldId: output.fieldId,
            outputFileName: output.fileName,
          },
        },
        recordTransitionAuditEvent: unaudited,
      });
      if (completed.type === "stale") {
        panic("Recording transcription completion returned no run");
      }
    },
  });
  if (Result.isError(created)) {
    observeFailure(created.error, { sink: runFailure });
    return "internal";
  }
  return null;
};

export const processRecordingTranscriptionRun = async (
  actor: RunActor,
  admission: ModelDispatchAdmission,
): Promise<void> => {
  const run = await claimRun(actor);
  if (run === RUN_AUTHORITY_REVOKED) {
    await setRunFailed(actor, "internal");
    return;
  }
  // Another delivery already claimed the run and may still be running it;
  // a run whose processor died is failed by the stuck-run sweep instead.
  if (run === null) {
    return;
  }
  const result = await Result.tryPromise({
    try: async () => await executeRun({ actor, admission, run }),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: runFailure });
    await setRunFailed(actor, "internal");
    return;
  }
  if (result.value !== null) {
    await setRunFailed(actor, result.value);
  }
};

/** The (timestamp, id) keyset the queued sweep's walk pages on. */
const queuedRunCursorCodec = createTimestampIdCursorCodec({
  column: recordingTranscriptionRuns.createdAt,
  brandId: brandPersistedRecordingTranscriptionRunId,
});

type QueuedRecordingTranscriptionRunRow = {
  createdCursor: string;
  id: SafeId<"recordingTranscriptionRun">;
  organizationId: SafeId<"organization">;
  requestedBy: string | null;
  workspaceId: SafeId<"workspace">;
};

type SettleTarget = "cancelled" | "failed";

/** Pages one settle sweep may walk per tick; the rest waits for the next. */
const SETTLE_PAGES_MAX = 10;

const reconcileRecordingTranscriptionRuns = async (
  db: BullMqWorkerContext["db"],
) => {
  const runningCutoff = new Date(
    Temporal.Now.instant().epochMilliseconds - STUCK_RUNNING_MS,
  );
  const readSettlePage = async (
    where: SQL | undefined,
    after: SafeId<"recordingTranscriptionRun"> | null,
  ) =>
    await db
      .select({ id: recordingTranscriptionRuns.id })
      .from(recordingTranscriptionRuns)
      .where(
        and(
          where,
          after === null ? undefined : gt(recordingTranscriptionRuns.id, after),
        ),
      )
      .orderBy(asc(recordingTranscriptionRuns.id))
      .limit(RECONCILE_SCAN_PAGE_SIZE);
  const settlePage = async (
    ids: SafeId<"recordingTranscriptionRun">[],
    to: SettleTarget,
  ): Promise<number> =>
    (
      await withAggregateTransaction(
        db,
        async (tx) =>
          await transitionBatch({
            tx,
            spec: RECORDING_TRANSCRIPTION_TRANSITIONS,
            ids,
            options: {
              from: [...RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES],
              to,
              set: {
                errorCode: to === "failed" ? "internal" : null,
                finishedAt: new Date(),
              },
            },
            recordTransitionAuditEvent: unaudited,
          }),
      )
    ).length;
  const settle = async (
    where: SQL | undefined,
    to: SettleTarget,
  ): Promise<number> => {
    let moved = 0;
    let after: SafeId<"recordingTranscriptionRun"> | null = null;
    for (let page = 0; page < SETTLE_PAGES_MAX; page += 1) {
      // db-await-in-loop: a keyset walk, one bounded page per round.
      const rows = await readSettlePage(where, after);
      const last = rows.at(-1);
      if (last === undefined) {
        break;
      }
      // db-await-in-loop: settles the page just read before reading the next.
      moved += await settlePage(
        rows.map(({ id }) => id),
        to,
      );
      if (rows.length < RECONCILE_SCAN_PAGE_SIZE) {
        break;
      }
      after = last.id;
    }
    return moved;
  };
  const cancelled = await settle(
    and(
      inArray(recordingTranscriptionRuns.status, [
        ...RECORDING_TRANSCRIPTION_RUN_ACTIVE_STATUSES,
      ]),
      isNull(recordingTranscriptionRuns.requestedBy),
    ),
    "cancelled",
  );
  const queuedAfter = (cursor: QueuedRecordingTranscriptionRunRow | null) =>
    cursor === null
      ? undefined
      : queuedRunCursorCodec.keysetAfter({
          cursor: {
            timestamp: reconcileCursorTimestamp(cursor.createdCursor),
            id: cursor.id,
          },
          idColumn: recordingTranscriptionRuns.id,
          direction: "ascending",
        });
  const readQueuedPage = async (
    cursor: QueuedRecordingTranscriptionRunRow | null,
  ) =>
    await db
      .select({
        createdCursor: queuedRunCursorCodec.cursorValue,
        id: recordingTranscriptionRuns.id,
        organizationId: recordingTranscriptionRuns.organizationId,
        requestedBy: recordingTranscriptionRuns.requestedBy,
        workspaceId: recordingTranscriptionRuns.workspaceId,
      })
      .from(recordingTranscriptionRuns)
      .where(
        and(
          eq(recordingTranscriptionRuns.status, "queued"),
          queuedAfter(cursor),
        ),
      )
      .orderBy(
        asc(recordingTranscriptionRuns.createdAt),
        asc(recordingTranscriptionRuns.id),
      )
      .limit(RECONCILE_SCAN_PAGE_SIZE);
  const handedOff = await reconcileQueuedRuns({
    queue: getQueue(),
    readPage: readQueuedPage,
    runJob,
  });
  const failed = await settle(
    and(
      inArray(recordingTranscriptionRuns.status, ["transcribing", "saving"]),
      lt(recordingTranscriptionRuns.startedAt, runningCutoff),
    ),
    "failed",
  );
  return { cancelled, failed, handedOff: handedOff.handedOff };
};

export const initRecordingTranscriptionRunWorker = ({
  db,
}: BullMqWorkerContext) => {
  const worker = new BullMqWorker<RecordingTranscriptionRunJobData>(
    QUEUE_NAME,
    async (job) => {
      const actor = brandActor(job.data);
      // The run's period action was drawn when it was queued; the job takes
      // a background slot.
      await runBackgroundJob({
        actionKind: "recording-transcription.background",
        organizationId: actor.organizationId,
        userId: actor.userId,
        organizationStateDb: actor.writeDb,
        job,
        signal: new AbortController().signal,
        run: async (_signal, admission) =>
          await processRecordingTranscriptionRun(actor, admission),
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
          setRunFailed(brandActor(job.data), "internal").catch(
            (markError: unknown) =>
              observeFailure(markError, { sink: runFailure }),
          ),
        "recording-transcription.set-run-failed",
      );
    }
    observeFailure(error, { sink: runFailure });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("recording_transcription.worker_error"),
  );
  const closeReconcile = startNonOverlappingInterval({
    intervalMs: ORPHAN_RECONCILE_INTERVAL_MS,
    run: async () => {
      const result = await reconcileRecordingTranscriptionRuns(db);
      if (result.cancelled > 0 || result.failed > 0 || result.handedOff > 0) {
        logger.info("recording_transcription.reconciled", {
          cancelled: String(result.cancelled),
          failed: String(result.failed),
          handedOff: String(result.handedOff),
        });
      }
    },
    onError: (error) => {
      observeFailure(error, { sink: reconcileFailure });
    },
  });
  return {
    queues: [QUEUE_NAME] as const,
    close: async () => {
      await closeReconcile();
      await worker.close();
    },
  };
};
