import { panic, Result } from "better-result";
import { Worker } from "bullmq";
import {
  and,
  asc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { SCOUT_KEY } from "@stll/api-contract/signals";
import { mapWithConcurrency } from "@stll/concurrency";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
  organizationSettings,
  SCOUT_RUN_STATUS,
  scoutRuns,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { detached } from "@/api/lib/detached";
import type { DocumentOcrPayload } from "@/api/lib/document-processing-contract";
import {
  DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
  serializeDocumentOcrPayload,
} from "@/api/lib/document-processing-contract";
import {
  DOCUMENT_PROCESSING_QUEUE_NAME,
  enqueueDocumentDeadlineScout,
  enqueueDocumentProcessingRun,
  type DocumentProcessingJobData,
} from "@/api/lib/document-processing-enqueue";
import { documentProcessingFailureFields } from "@/api/lib/document-processing-failure-fields";
import { DocumentOcrError } from "@/api/lib/document-processing-ocr-result";
import {
  automaticOcrRetryDelayMs,
  DOCUMENT_PROCESSING_FAILURE_REPORT,
  documentProcessingFailureReport,
  DocumentProcessingRunSettledError,
  isRetryableAutomaticOcrFailure,
  isRetryableOcrDerivativeFailure,
  isRetryableSearchIndexFailure,
  retryableOcrFailureCodes,
  settleDocumentProcessingAttemptError,
} from "@/api/lib/document-processing-queue-attempt";
import {
  AUTOMATIC_OCR_MAX_ATTEMPTS,
  classifyOcrProjectionSource,
  classifyOcrWorkspaceDispatch,
  DocumentProcessingJobError,
  indexDocumentProjection,
  isCurrentNativeExtractionSource,
  isCurrentOcrSource,
  isPreservableAutomaticProjection,
  ownsPromotedManualOcrClaim,
  requiresOcrPolicy,
  SEARCH_INDEX_ATTEMPT_TIMEOUT_MS,
  SEARCHABLE_PDF_FAILURE_CODE,
  SEARCH_INDEX_FAILURE_CODE,
  shouldFailStaleAutomaticOcrRun,
  shouldPreserveCurrentProjection,
} from "@/api/lib/document-processing-queue-policy";
import type { CurrentDocumentSource } from "@/api/lib/document-processing-queue-policy";
import { startDocumentOcrWorkerReadiness } from "@/api/lib/document-processing-readiness";
import { createReconciliationProgress } from "@/api/lib/document-processing-reconciliation-progress";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import { createFileKey, createOcrSearchablePdfKey } from "@/api/lib/file-key";
import { logger } from "@/api/lib/observability/logger";
import {
  isLocalDocumentOcrConfigured,
  recognizePdfTextLocally,
} from "@/api/lib/ocr-local/recognize-local";
import { createOcrSearchablePdf } from "@/api/lib/ocr-searchable-pdf";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import {
  createBullMqConnection,
  createLazyRedisClient,
  createRedisClient,
  isTransientRedisConnectionError,
} from "@/api/lib/redis-client";
import { unboundedCoordinationKey } from "@/api/lib/redis-keys";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import {
  readTenantS3ArrayBuffer,
  writeTenantS3Object,
} from "@/api/lib/s3-presign";
import { brandPersistedFieldId } from "@/api/lib/safe-id-boundaries";
import { documentScoutsEnabled } from "@/api/lib/scouts/document-scout-config";
import {
  executeNativeExtraction,
  requiresDurableNativeExtraction,
} from "@/api/lib/search/process-extraction";
import { getSearchProvider } from "@/api/lib/search/provider";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 30_000;
export const RECONCILE_BATCH_SIZE = 100;
const ENQUEUE_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;
const ENQUEUE_FAILURE_RETRY_MS = 30_000;
const QUEUED_OCR_SELECTION = {
  ALL_DUE: "all-due",
  SCHEDULED_RETRIES: "scheduled-retries",
} as const;
const WORKER_LEASE_TIMEOUT_MS = 40 * 60 * 1000;
const WORKER_LEASE_HEARTBEAT_MS = 5 * 60 * 1000;
const WORKER_LEASE_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEADLINE_SCOUT_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const DEADLINE_SCOUT_DISPATCH_CONCURRENCY = 4;
const SEARCH_INDEX_REPLAY_CONCURRENCY = 2;
const SEARCH_INDEX_REPLAY_BATCH_SIZE = SEARCH_INDEX_REPLAY_CONCURRENCY * 2;
const SEARCH_INDEX_REPLAY_STATE_TRANSITION_TIMEOUT_MS = 5000;
const REPAIR_SETTLE_DELAY_MS = 5 * 60 * 1000;
// Single compare-and-set slot for the repair sweep's resume position, so the
// sweep is its own colocation unit. Declared unbounded in redis-keys.ts: the
// CAS script below deliberately writes it without an expiry.
const REPAIR_SCAN_CURSOR_KEY = unboundedCoordinationKey({
  scope: "ocr-repair-cursor",
  slot: "repair-scan",
  suffix: "v1",
});
const REPAIR_SCAN_CURSOR_COMMAND_TIMEOUT_MS = 2000;
const QUEUE_HANDOFF_TIMEOUT_MS = 2000;
const REPAIR_SCAN_CURSOR_CAS_SCRIPT = `
  local current = redis.call('GET', KEYS[1])
  local expected = ARGV[1]
  if (expected == '' and current == false) or current == expected then
    if ARGV[2] == '' then
      redis.call('DEL', KEYS[1])
    else
      redis.call('SET', KEYS[1], ARGV[2])
    end
    return 1
  end
  return 0
`;
const SOURCE_SUPERSEDED_CANCELLATION_CODE = "source_superseded";

/**
 * Builds and stores the run's cached searchable PDF.
 *
 * The source read, the overlay, and the derivative write are one stage under a
 * single failure code: a storage blip is as retryable as a generation failure,
 * so neither can leave a persisted projection permanently without its PDF.
 */
const writeOcrSearchablePdfDerivative = async ({
  lifecycleSignal,
  payload,
  run,
  sourceKey,
}: {
  lifecycleSignal: AbortSignal;
  payload: DocumentOcrPayload;
  run: typeof documentProcessingRuns.$inferSelect;
  sourceKey: string;
}): Promise<void> => {
  const written = await Result.tryPromise({
    try: async () => {
      const scope = {
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
      };
      const sourceBuffer = await readTenantS3ArrayBuffer({
        key: sourceKey,
        scope,
        signal: lifecycleSignal,
      });
      lifecycleSignal.throwIfAborted();
      const searchablePdf = await createOcrSearchablePdf(sourceBuffer, payload);
      if (Result.isError(searchablePdf)) {
        throw searchablePdf.error;
      }
      lifecycleSignal.throwIfAborted();

      await writeTenantS3Object({
        contentType: PDF_MIME_TYPE,
        data: searchablePdf.value,
        key: createOcrSearchablePdfKey({
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          runId: run.id,
        }),
        scope,
        signal: lifecycleSignal,
      });
    },
    catch: (cause) => cause,
  });
  lifecycleSignal.throwIfAborted();
  if (Result.isError(written)) {
    throw new DocumentProcessingJobError({
      code: SEARCHABLE_PDF_FAILURE_CODE,
      message: "OCR text was stored but the searchable PDF was not",
      cause: written.error,
    });
  }
};

const markRunCancelled = async (
  runId: SafeId<"documentProcessingRun">,
  claimToken: string,
  cancellationCode:
    | "policy_disabled"
    | "source_superseded"
    | "workspace_unavailable",
): Promise<boolean> => {
  const cancelled = await rootDb
    .update(documentProcessingRuns)
    .set({
      claimedAt: null,
      claimedBy: null,
      errorAt: new Date(),
      errorCode: cancellationCode,
      finishedAt: new Date(),
      status: "cancelled",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, runId),
        eq(documentProcessingRuns.status, "running"),
        eq(documentProcessingRuns.claimedBy, claimToken),
        cancellationCode === "policy_disabled"
          ? ne(documentProcessingRuns.requestSource, "manual")
          : undefined,
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return Boolean(cancelled.at(0));
};

type DocumentProcessingLeaseHeartbeat = {
  stop: () => void;
};

export const createDocumentProcessingLeaseRenewal = ({
  onError,
  renewLease,
  timeoutMs = WORKER_LEASE_HEARTBEAT_TIMEOUT_MS,
}: {
  onError: (error: unknown) => void;
  renewLease: () => Promise<void>;
  timeoutMs?: number;
}): (() => void) => {
  // Track the raw DB operation, not the deadline wrapper. A timed-out update
  // may still be running because the database client cannot cancel it; keeping
  // this slot occupied prevents later interval ticks from piling on more work.
  let renewalInFlight: Promise<void> | null = null;

  return () => {
    if (renewalInFlight) {
      return;
    }

    const renewal = renewLease();
    renewalInFlight = renewal;
    const releaseRenewal = () => {
      if (renewalInFlight === renewal) {
        renewalInFlight = null;
      }
    };
    detached(
      renewal.then(releaseRenewal, releaseRenewal),
      "document-processing.lease-heartbeat-release",
    );
    detached(
      (async () => {
        const result = await Result.tryPromise({
          try: async () =>
            await withTimeout(async () => await renewal, {
              label: "document processing lease heartbeat",
              timeoutMs,
            }),
          catch: (cause) => cause,
        });
        if (Result.isError(result)) {
          onError(result.error);
        }
      })(),
      "document-processing.lease-heartbeat-renew",
    );
  };
};

const startDocumentProcessingLeaseHeartbeat = ({
  claimToken,
  runId,
}: {
  claimToken: string;
  runId: SafeId<"documentProcessingRun">;
}): DocumentProcessingLeaseHeartbeat => {
  const renew = createDocumentProcessingLeaseRenewal({
    renewLease: async () => {
      await rootDb
        .update(documentProcessingRuns)
        .set({
          claimedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentProcessingRuns.id, runId),
            eq(documentProcessingRuns.status, "running"),
            eq(documentProcessingRuns.claimedBy, claimToken),
          ),
        );
    },
    onError: (error) => {
      logger.warn("document_processing.lease_heartbeat_failed", {
        "error.type": errorTag(error),
        runId,
      });
    },
  });

  const timer = setInterval(() => {
    renew();
  }, WORKER_LEASE_HEARTBEAT_MS);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
};

const readCurrentDocumentSource = async ({
  entityId,
  fieldId,
  organizationId,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}): Promise<CurrentDocumentSource | null> => {
  const rows = await rootDb
    .select({
      content: fields.content,
      currentVersionId: entities.currentVersionId,
      entityReadOnly: entities.readOnly,
      fieldEntityVersionId: fields.entityVersionId,
      versionDeletedAt: entityVersions.deletedAt,
    })
    .from(entities)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.status, "active"),
      ),
    )
    .innerJoin(
      fields,
      and(eq(fields.id, fieldId), eq(fields.workspaceId, workspaceId)),
    )
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, fields.entityVersionId),
        eq(entityVersions.entityId, entities.id),
        eq(entityVersions.workspaceId, workspaceId),
      ),
    )
    .where(
      and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
    )
    .limit(1);

  return rows.at(0) ?? null;
};

type OcrProjectionPersistenceOutcome =
  | "persisted"
  | "preserved"
  | "source_cancelled"
  | "stale_claim";

const persistOcrProjection = async ({
  claimToken,
  ciphertext,
  iv,
  ocrPayloadCiphertext,
  ocrPayloadIv,
  pageCount,
  run,
  textLength,
}: {
  claimToken: string;
  ciphertext: Buffer;
  iv: Buffer;
  ocrPayloadCiphertext: Buffer;
  ocrPayloadIv: Buffer;
  pageCount: number;
  run: typeof documentProcessingRuns.$inferSelect;
  textLength: number;
}): Promise<OcrProjectionPersistenceOutcome> =>
  await rootDb.transaction(async (tx) => {
    const lockedRows = await tx
      .select({
        content: fields.content,
        currentVersionId: entities.currentVersionId,
        entityReadOnly: entities.readOnly,
        fieldEntityVersionId: fields.entityVersionId,
        versionDeletedAt: entityVersions.deletedAt,
      })
      .from(entities)
      .innerJoin(
        fields,
        and(
          eq(fields.id, run.fieldId),
          eq(fields.workspaceId, run.workspaceId),
        ),
      )
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, fields.entityVersionId),
          eq(entityVersions.entityId, entities.id),
          eq(entityVersions.workspaceId, run.workspaceId),
        ),
      )
      .where(
        and(
          eq(entities.id, run.entityId),
          eq(entities.workspaceId, run.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    // Keep every OCR path on entity -> workspace -> run. Version replacement,
    // workspace sealing, manual requests, and projection persistence can then
    // contend without forming a lock cycle.
    const workspaceRows = await tx
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, run.workspaceId),
          eq(workspaces.organizationId, run.organizationId),
        ),
      )
      .limit(1)
      .for("update");
    const ownedClaims = await tx
      .update(documentProcessingRuns)
      .set({ claimedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(documentProcessingRuns.id, run.id),
          eq(documentProcessingRuns.status, "running"),
          eq(documentProcessingRuns.claimedBy, claimToken),
        ),
      )
      .returning({
        id: documentProcessingRuns.id,
        requestSource: documentProcessingRuns.requestSource,
      });
    const ownedClaim = ownedClaims.at(0);
    if (!ownedClaim) {
      return "stale_claim";
    }

    const source = lockedRows.at(0) ?? null;
    const sourceState = classifyOcrProjectionSource({
      run,
      source,
      workspaceStatus: workspaceRows.at(0)?.status,
    });
    if (sourceState !== "current") {
      await tx
        .update(documentProcessingRuns)
        .set({
          claimedAt: null,
          claimedBy: null,
          errorAt: new Date(),
          errorCode: sourceState,
          finishedAt: new Date(),
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentProcessingRuns.id, run.id),
            eq(documentProcessingRuns.status, "running"),
            eq(documentProcessingRuns.claimedBy, claimToken),
          ),
        );
      return "source_cancelled";
    }

    // Native extraction takes the same entity lock before it persists a
    // projection. An automatic OCR run that lost that race must index the
    // selected current-version text, even when it came from another file
    // field; an explicit manual request intentionally selects a fresh source.
    if (shouldPreserveCurrentProjection(ownedClaim.requestSource)) {
      const projections = await tx
        .select({
          ocrRunId: extractedContent.ocrRunId,
          sourceEntityVersionId: extractedContent.sourceEntityVersionId,
          sourceFieldId: extractedContent.sourceFieldId,
          sourceFileId: extractedContent.sourceFileId,
          sourceSha256Hex: extractedContent.sourceSha256Hex,
        })
        .from(extractedContent)
        .where(
          and(
            eq(extractedContent.entityId, run.entityId),
            eq(extractedContent.organizationId, run.organizationId),
            eq(extractedContent.workspaceId, run.workspaceId),
          ),
        )
        .limit(1);
      const projection = projections.at(0);
      const projectionSourceRows = projection?.sourceFieldId
        ? await tx
            .select({
              content: fields.content,
              entityVersionId: fields.entityVersionId,
              id: fields.id,
              workspaceId: fields.workspaceId,
            })
            .from(fields)
            .where(
              and(
                eq(fields.id, projection.sourceFieldId),
                eq(fields.workspaceId, run.workspaceId),
              ),
            )
            .limit(1)
        : [];
      if (
        projection &&
        projection.ocrRunId !== run.id &&
        isPreservableAutomaticProjection({
          currentEntityVersionId: run.entityVersionId,
          currentWorkspaceId: run.workspaceId,
          provenance: projection,
          sourceField: projectionSourceRows.at(0) ?? null,
        })
      ) {
        return "preserved";
      }
    }

    await tx
      .insert(extractedContent)
      .values({
        workspaceId: run.workspaceId,
        entityId: run.entityId,
        organizationId: run.organizationId,
        sourceEntityVersionId: run.entityVersionId,
        sourceFieldId: run.fieldId,
        sourceFileId: run.sourceFileId,
        sourceSha256Hex: run.sourceSha256Hex,
        ocrRunId: run.id,
        ocrProcessorVersion: run.processorVersion,
        ocrPayloadCiphertext,
        ocrPayloadIv,
        ciphertext,
        iv,
        charCount: textLength,
        language: null,
        extractedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: extractedContent.entityId,
        set: {
          sourceEntityVersionId: run.entityVersionId,
          sourceFieldId: run.fieldId,
          sourceFileId: run.sourceFileId,
          sourceSha256Hex: run.sourceSha256Hex,
          ocrRunId: run.id,
          ocrProcessorVersion: run.processorVersion,
          ocrPayloadCiphertext,
          ocrPayloadIv,
          ciphertext,
          iv,
          charCount: textLength,
          language: null,
          extractedAt: new Date(),
        },
      });

    await tx
      .update(documentProcessingRuns)
      .set({
        progressCompleted: pageCount,
        progressTotal: pageCount,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingRuns.id, run.id),
          eq(documentProcessingRuns.status, "running"),
          eq(documentProcessingRuns.claimedBy, claimToken),
        ),
      );
    return "persisted";
  });

const completeDocumentProcessingRun = async ({
  claimToken,
  run,
}: {
  claimToken: string;
  run: typeof documentProcessingRuns.$inferSelect;
}): Promise<boolean> => {
  const shouldDispatchDeadlineScout = documentScoutsEnabled(
    envDocumentProcessingWorker,
  );
  const completed = await rootDb
    .update(documentProcessingRuns)
    .set({
      claimedAt: null,
      claimedBy: null,
      deadlineScoutAttemptCount: 0,
      deadlineScoutClaimedAt: null,
      deadlineScoutErrorCode: null,
      deadlineScoutStatus: shouldDispatchDeadlineScout
        ? "pending"
        : "not_requested",
      errorAt: null,
      errorCode: null,
      finishedAt: new Date(),
      nextAttemptAt: null,
      status: "succeeded",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, run.id),
        eq(documentProcessingRuns.status, "running"),
        eq(documentProcessingRuns.claimedBy, claimToken),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  if (!completed.at(0)) {
    return false;
  }
  if (shouldDispatchDeadlineScout) {
    const enqueued = await Result.tryPromise(async () => {
      await enqueueDocumentDeadlineScout({
        sourceRunId: run.id,
      });
    });
    if (Result.isError(enqueued)) {
      captureError(enqueued.error, { runId: run.id });
      logger.error("document_processing.deadline_scout_enqueue_failed", {
        "error.type": errorTag(enqueued.error),
        runId: run.id,
      });
    }
  }
  broadcastWorkspaceResourceUpdated(
    run.workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: run.entityId }),
  );
  return true;
};

type IndexDocumentProjectionAtJobBoundaryOptions = {
  indexEntity: () => Promise<void>;
};

export const indexDocumentProjectionAtJobBoundary = async ({
  indexEntity,
}: IndexDocumentProjectionAtJobBoundaryOptions): Promise<void> => {
  const indexed = await indexDocumentProjection({ indexEntity });
  if (Result.isError(indexed)) {
    throw indexed.error;
  }
};

export const processDocumentProcessingRun = async (
  runId: SafeId<"documentProcessingRun">,
  lifecycleSignal: AbortSignal,
): Promise<void> => {
  lifecycleSignal.throwIfAborted();
  const claimToken = Bun.randomUUIDv7();
  const run = await rootDb.transaction(async (tx) => {
    const runRows = await tx
      .select({
        entityId: documentProcessingRuns.entityId,
        entityVersionId: documentProcessingRuns.entityVersionId,
        kind: documentProcessingRuns.kind,
        organizationId: documentProcessingRuns.organizationId,
        requestSource: documentProcessingRuns.requestSource,
        workspaceId: documentProcessingRuns.workspaceId,
      })
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, runId))
      .limit(1);
    const runContext = runRows.at(0);
    if (!runContext) {
      return null;
    }

    // Deleting a version takes this same entity lock before tombstoning and
    // rejects the tombstone while an OCR run is dispatching. Conversely, a
    // worker that arrives after the tombstone observes the replaced current
    // version and cancels without sending the withdrawn bytes to a provider.
    const entityRows = await tx
      .select({ currentVersionId: entities.currentVersionId })
      .from(entities)
      .where(
        and(
          eq(entities.id, runContext.entityId),
          eq(entities.workspaceId, runContext.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    if (entityRows.at(0)?.currentVersionId !== runContext.entityVersionId) {
      await tx
        .update(documentProcessingRuns)
        .set({
          errorAt: new Date(),
          errorCode: "source_superseded",
          finishedAt: new Date(),
          status: "cancelled",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentProcessingRuns.id, runId),
            inArray(documentProcessingRuns.status, ["queued", "failed"]),
          ),
        );
      return null;
    }

    // This row lock is the dispatch fence. Workspace archive/delete obtains
    // the same lock before transitioning away from active and refuses to
    // seal while a run is `running`, so a worker cannot begin OCR after the
    // workspace has become unavailable.
    const workspaceRows = await tx
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, runContext.workspaceId),
          eq(workspaces.organizationId, runContext.organizationId),
        ),
      )
      .limit(1)
      .for("update");
    const workspace = workspaceRows.at(0);
    const workspaceDispatch = classifyOcrWorkspaceDispatch({
      requestSource: runContext.requestSource,
      workspaceStatus: workspace?.status,
    });
    switch (workspaceDispatch) {
      case "available":
        break;
      case "deferred":
        // A deletion seal is reversible until object cleanup and the final
        // database delete succeed. Keep an acknowledged manual request queued
        // so reconciliation can deliver it if the workspace returns to active.
        return null;
      case "workspace_unavailable":
        await tx
          .update(documentProcessingRuns)
          .set({
            errorAt: new Date(),
            errorCode: "workspace_unavailable",
            finishedAt: new Date(),
            status: "cancelled",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documentProcessingRuns.id, runId),
              inArray(documentProcessingRuns.status, ["queued", "failed"]),
            ),
          );
        return null;
      default:
        workspaceDispatch satisfies never;
        panic(`Unhandled workspace dispatch: ${String(workspaceDispatch)}`);
    }

    // Opt-out takes this same settings lock before checking for running
    // automatic jobs. Either it wins and a later worker observes `off` before
    // claiming, or the worker wins and opt-out refuses until this dispatch is
    // terminal; neither path can acknowledge opt-out while it sends a file.
    if (runContext.kind === "ocr") {
      const settingsRows = await tx
        .select({
          documentProcessingMode: organizationSettings.documentProcessingMode,
        })
        .from(organizationSettings)
        .where(
          eq(organizationSettings.organizationId, runContext.organizationId),
        )
        .limit(1)
        .for("update");
      if (
        requiresOcrPolicy(runContext.requestSource) &&
        settingsRows.at(0)?.documentProcessingMode !== "searchable-text"
      ) {
        await tx
          .update(documentProcessingRuns)
          .set({
            errorAt: new Date(),
            errorCode: "policy_disabled",
            finishedAt: new Date(),
            status: "cancelled",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documentProcessingRuns.id, runId),
              inArray(documentProcessingRuns.status, ["queued", "failed"]),
            ),
          );
        return null;
      }
    }

    lifecycleSignal.throwIfAborted();
    const claimedRows = await tx
      .update(documentProcessingRuns)
      .set({
        attemptCount: sql`${documentProcessingRuns.attemptCount} + 1`,
        claimedAt: new Date(),
        claimedBy: claimToken,
        errorAt: null,
        errorCode: null,
        finishedAt: null,
        nextAttemptAt: null,
        progressCompleted: 0,
        progressTotal: null,
        startedAt: new Date(),
        status: "running",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingRuns.id, runId),
          inArray(documentProcessingRuns.status, ["queued", "failed"]),
        ),
      )
      .returning();
    return claimedRows.at(0) ?? null;
  });
  if (!run) {
    return;
  }

  const heartbeat = startDocumentProcessingLeaseHeartbeat({
    claimToken,
    runId: run.id,
  });
  const processingResult = await Result.tryPromise({
    try: async () => {
      lifecycleSignal.throwIfAborted();
      if (run.kind === "ocr") {
        const settings = await rootDb.query.organizationSettings.findFirst({
          where: { organizationId: { eq: run.organizationId } },
          columns: { documentProcessingMode: true },
        });
        const currentRuns = await rootDb
          .select({ requestSource: documentProcessingRuns.requestSource })
          .from(documentProcessingRuns)
          .where(eq(documentProcessingRuns.id, run.id))
          .limit(1);
        if (
          requiresOcrPolicy(
            currentRuns.at(0)?.requestSource ?? run.requestSource,
          ) &&
          settings?.documentProcessingMode !== "searchable-text"
        ) {
          const cancelled = await markRunCancelled(
            run.id,
            claimToken,
            "policy_disabled",
          );
          if (cancelled) {
            return;
          }

          const promotedRuns = await rootDb
            .select({
              claimedBy: documentProcessingRuns.claimedBy,
              requestSource: documentProcessingRuns.requestSource,
              status: documentProcessingRuns.status,
            })
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.id, run.id))
            .limit(1);
          if (
            !ownsPromotedManualOcrClaim({
              claimToken,
              run: promotedRuns.at(0),
            })
          ) {
            return;
          }
        }
      }

      const source = await readCurrentDocumentSource({
        entityId: run.entityId,
        fieldId: run.fieldId,
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
      });
      switch (run.kind) {
        case "native-extraction": {
          if (!isCurrentNativeExtractionSource(run, source)) {
            await markRunCancelled(run.id, claimToken, "source_superseded");
            return;
          }
          const extractionOutcome = await executeNativeExtraction({
            fileField: source.content,
            lifecycleSignal,
            readSource: async (key, signal) =>
              await readTenantS3ArrayBuffer({
                key,
                scope: {
                  organizationId: run.organizationId,
                  workspaceId: run.workspaceId,
                },
                signal,
              }),
            run,
          });
          switch (extractionOutcome) {
            case "persisted":
            case "preserved":
              break;
            case "source_cancelled":
              await markRunCancelled(run.id, claimToken, "source_superseded");
              return;
            default:
              extractionOutcome satisfies never;
              panic(
                `Unhandled extraction outcome: ${String(extractionOutcome)}`,
              );
          }
          lifecycleSignal.throwIfAborted();
          const persistedSource = await readCurrentDocumentSource({
            entityId: run.entityId,
            fieldId: run.fieldId,
            organizationId: run.organizationId,
            workspaceId: run.workspaceId,
          });
          if (!isCurrentNativeExtractionSource(run, persistedSource)) {
            await markRunCancelled(run.id, claimToken, "source_superseded");
            return;
          }
          await indexDocumentProjectionAtJobBoundary({
            indexEntity: async () =>
              await getSearchProvider().indexEntity(run.entityId),
          });
          lifecycleSignal.throwIfAborted();
          await completeDocumentProcessingRun({ claimToken, run });
          return;
        }
        case "ocr":
          break;
        default:
          run.kind satisfies never;
          panic(`Unhandled kind: ${String(run.kind)}`);
      }
      if (!isCurrentOcrSource({ run, source })) {
        await markRunCancelled(run.id, claimToken, "source_superseded");
        return;
      }

      const sourceKey = createFileKey({
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        fileId: run.sourceFileId,
        mimeType: PDF_MIME_TYPE,
      });
      const result = await recognizePdfTextLocally({
        signal: lifecycleSignal,
        sourceKey,
      });
      if (Result.isError(result)) {
        throw new DocumentProcessingJobError({
          code: result.error.code,
          message: result.error.message,
          cause: result.error,
        });
      }
      lifecycleSignal.throwIfAborted();

      const [encrypted, encryptedPayload] = await Promise.all([
        encryptContent(run.organizationId, result.value.text),
        encryptContent(
          run.organizationId,
          serializeDocumentOcrPayload(result.value.payload),
        ),
      ]);
      lifecycleSignal.throwIfAborted();
      const persistenceOutcome = await persistOcrProjection({
        claimToken,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        ocrPayloadCiphertext: encryptedPayload.ciphertext,
        ocrPayloadIv: encryptedPayload.iv,
        pageCount: result.value.pageCount,
        run,
        textLength: result.value.text.length,
      });
      switch (persistenceOutcome) {
        case "persisted":
        case "preserved":
          break;
        case "source_cancelled":
        case "stale_claim":
          return;
        default:
          persistenceOutcome satisfies never;
          panic(`Unhandled persistence outcome: ${String(persistenceOutcome)}`);
      }
      lifecycleSignal.throwIfAborted();

      // The derivative is written before indexing: a failed index leaves a
      // retryable run that `recoverFailedSearchIndex` completes without
      // revisiting storage, so ordering it after indexing would let that
      // replay mark a run succeeded that never got its searchable PDF.
      if (persistenceOutcome === "persisted") {
        await writeOcrSearchablePdfDerivative({
          lifecycleSignal,
          payload: result.value.payload,
          run,
          sourceKey,
        });
      }

      await indexDocumentProjectionAtJobBoundary({
        indexEntity: async () =>
          await getSearchProvider().indexEntity(run.entityId),
      });
      lifecycleSignal.throwIfAborted();

      await completeDocumentProcessingRun({ claimToken, run });
    },
    catch: (cause) => cause,
  });
  heartbeat.stop();

  if (Result.isError(processingResult)) {
    const settlement = await settleDocumentProcessingAttemptError({
      error: processingResult.error,
      lifecycleSignal,
      markFailed: async () =>
        markRunFailed({
          claimToken,
          error: processingResult.error,
          run,
        }),
      returnToQueue: async () => {
        await returnInterruptedRunToQueue({ claimToken, run });
      },
    });
    if (settlement === "unsettled") {
      throw processingResult.error;
    }
    // Rethrown so BullMQ records the job as failed. The settle above has
    // already reported this attempt, so it goes back wrapped: the job-level
    // handler reports only what reaches it unsettled.
    throw new DocumentProcessingRunSettledError({
      cause: processingResult.error,
      message:
        processingResult.error instanceof Error
          ? processingResult.error.message
          : "Document processing run failed",
    });
  }
};

const errorCode = (error: unknown): string => {
  if (
    error instanceof DocumentProcessingJobError ||
    error instanceof DocumentOcrError
  ) {
    return error.code;
  }
  return "processing_failed";
};

type MarkRunFailedOutcome = {
  attemptCount: number;
  retryScheduled: boolean;
};

const markRunFailed = async ({
  claimToken,
  error,
  run,
}: {
  claimToken: string;
  error: unknown;
  run: typeof documentProcessingRuns.$inferSelect;
}): Promise<"settled" | "unsettled"> => {
  const failureCode = errorCode(error);
  const outcome = await rootDb.transaction(
    async (tx): Promise<MarkRunFailedOutcome | null> => {
      const ownedRows = await tx
        .select({
          attemptCount: documentProcessingRuns.attemptCount,
          requestSource: documentProcessingRuns.requestSource,
        })
        .from(documentProcessingRuns)
        .where(
          and(
            eq(documentProcessingRuns.id, run.id),
            eq(documentProcessingRuns.status, "running"),
            eq(documentProcessingRuns.claimedBy, claimToken),
          ),
        )
        .limit(1)
        .for("update");
      const owned = ownedRows.at(0);
      if (!owned) {
        return null;
      }
      const retryable = isRetryableAutomaticOcrFailure({
        attemptCount: owned.attemptCount,
        errorCode: failureCode,
        requestSource: owned.requestSource,
      });
      const retryableSearchIndex = isRetryableSearchIndexFailure(failureCode);
      const retryableDerivative = isRetryableOcrDerivativeFailure({
        attemptCount: owned.attemptCount,
        errorCode: failureCode,
      });
      const retryScheduled =
        retryable || retryableSearchIndex || retryableDerivative;
      await tx
        .update(documentProcessingRuns)
        .set({
          claimedAt: null,
          claimedBy: null,
          errorAt: new Date(),
          errorCode: failureCode,
          nextAttemptAt: retryScheduled
            ? new Date(
                Date.now() + automaticOcrRetryDelayMs(owned.attemptCount),
              )
            : null,
          status: "failed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentProcessingRuns.id, run.id),
            eq(documentProcessingRuns.status, "running"),
            eq(documentProcessingRuns.claimedBy, claimToken),
          ),
        );
      return { attemptCount: owned.attemptCount, retryScheduled };
    },
  );
  if (outcome === null) {
    return "unsettled";
  }
  // One exception per run, at its terminal transition. An attempt whose
  // failure schedules a retry is expected churn of the durable retry model
  // and stays a structured log; capturing every attempt reported the same
  // defect up to AUTOMATIC_OCR_MAX_ATTEMPTS times.
  if (outcome.retryScheduled) {
    logger.warn("document_processing.attempt_failed", {
      ...documentProcessingFailureFields(error),
      attempt: String(outcome.attemptCount),
      errorCode: failureCode,
      runId: run.id,
    });
    return "settled";
  }
  captureError(error, { runId: run.id });
  logger.error("document_processing.run_failed", {
    ...documentProcessingFailureFields(error),
    errorCode: failureCode,
    runId: run.id,
  });
  return "settled";
};

const returnInterruptedRunToQueue = async ({
  claimToken,
  run,
}: {
  claimToken: string;
  run: typeof documentProcessingRuns.$inferSelect;
}): Promise<void> => {
  await rootDb
    .update(documentProcessingRuns)
    .set({
      attemptCount: Math.max(0, run.attemptCount - 1),
      claimedAt: null,
      claimedBy: null,
      errorAt: null,
      errorCode: null,
      finishedAt: null,
      nextAttemptAt: new Date(),
      progressCompleted: 0,
      progressTotal: null,
      startedAt: null,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, run.id),
        eq(documentProcessingRuns.status, "running"),
        eq(documentProcessingRuns.attemptCount, run.attemptCount),
        eq(documentProcessingRuns.claimedBy, claimToken),
      ),
    );
};

const earlierFileFields = alias(
  fields,
  "document_processing_earlier_file_fields",
);

type DocumentProcessingCandidate = {
  content: Extract<FieldContent, { type: "file" }>;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

/**
 * The repair sweep's cursor store, and the only Redis the reconciliation
 * loop touches. It owns its connection: the client is unreachable except
 * through `ready()`, so no call site here can issue a cursor command on a
 * client that is still connecting, which this one would reject outright
 * rather than wait for.
 */
const reconciliationRedis = createLazyRedisClient(() =>
  createRedisClient({
    connectionTimeout: REPAIR_SCAN_CURSOR_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  }),
);

export const readRepairScanCursor = async (
  readCursor: () => Promise<string | null> = async () =>
    await (await reconciliationRedis.ready()).get(REPAIR_SCAN_CURSOR_KEY),
  timeoutMs = REPAIR_SCAN_CURSOR_COMMAND_TIMEOUT_MS,
): Promise<SafeId<"field"> | null> => {
  const cursor = await withTimeout(readCursor, {
    label: "document OCR repair cursor read",
    timeoutMs,
  });
  return cursor === null ? null : brandPersistedFieldId(cursor);
};

export const writeRepairScanCursor = async ({
  expectedCursor,
  nextCursor,
  sendCommand = async (command, args) =>
    Number(await (await reconciliationRedis.ready()).send(command, args)),
  timeoutMs = REPAIR_SCAN_CURSOR_COMMAND_TIMEOUT_MS,
}: {
  expectedCursor: SafeId<"field"> | null;
  nextCursor: SafeId<"field"> | null;
  sendCommand?: (command: string, args: string[]) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<boolean> =>
  Number(
    await withTimeout(
      async () =>
        await sendCommand("EVAL", [
          REPAIR_SCAN_CURSOR_CAS_SCRIPT,
          "1",
          REPAIR_SCAN_CURSOR_KEY,
          expectedCursor ?? "",
          nextCursor ?? "",
        ]),
      {
        label: "document OCR repair cursor write",
        timeoutMs,
      },
    ),
  ) === 1;

const isSameNativeExtractionSource = (
  candidate: DocumentProcessingCandidate,
  field: {
    content: FieldContent;
    entityVersionId: SafeId<"entityVersion">;
    id: SafeId<"field">;
    workspaceId: SafeId<"workspace">;
  },
): boolean =>
  field.content.type === "file" &&
  requiresDurableNativeExtraction(field.content) &&
  field.id === candidate.fieldId &&
  field.workspaceId === candidate.workspaceId &&
  field.entityVersionId === candidate.entityVersionId &&
  field.content.id === candidate.content.id &&
  field.content.sha256Hex === candidate.content.sha256Hex;

const persistMissingNativeExtractionRuns = async (
  candidates: DocumentProcessingCandidate[],
  database: typeof rootDb = rootDb,
): Promise<SafeId<"documentProcessingRun">[]> => {
  if (candidates.length === 0) {
    return [];
  }

  return await database.transaction(async (tx) => {
    const lockedEntities = await tx
      .select({
        currentVersionId: entities.currentVersionId,
        id: entities.id,
        readOnly: entities.readOnly,
        workspaceId: entities.workspaceId,
      })
      .from(entities)
      .where(
        and(
          inArray(
            entities.id,
            candidates.map(({ entityId }) => entityId),
          ),
          inArray(
            entities.workspaceId,
            candidates.map((candidate) => candidate.workspaceId),
          ),
        ),
      )
      .orderBy(asc(entities.id))
      .limit(RECONCILE_BATCH_SIZE)
      .for("update");
    const lockedEntityById = new Map(
      lockedEntities.map((entity) => [entity.id, entity]),
    );
    const currentFields = await tx
      .select({
        content: fields.content,
        entityVersionId: fields.entityVersionId,
        id: fields.id,
        workspaceId: fields.workspaceId,
      })
      .from(fields)
      .where(
        and(
          inArray(
            fields.id,
            candidates.map(({ fieldId }) => fieldId),
          ),
          inArray(
            fields.workspaceId,
            candidates.map((candidate) => candidate.workspaceId),
          ),
        ),
      )
      .limit(RECONCILE_BATCH_SIZE);
    const currentFieldById = new Map(
      currentFields.map((field) => [field.id, field]),
    );
    const currentProjections = await tx
      .select({
        entityId: extractedContent.entityId,
        sourceEntityVersionId: extractedContent.sourceEntityVersionId,
        sourceFieldId: extractedContent.sourceFieldId,
        sourceFileId: extractedContent.sourceFileId,
        sourceSha256Hex: extractedContent.sourceSha256Hex,
      })
      .from(extractedContent)
      .where(
        and(
          inArray(
            extractedContent.organizationId,
            candidates.map((candidate) => candidate.organizationId),
          ),
          inArray(
            extractedContent.workspaceId,
            candidates.map((candidate) => candidate.workspaceId),
          ),
          inArray(
            extractedContent.entityId,
            candidates.map(({ entityId }) => entityId),
          ),
        ),
      )
      .limit(RECONCILE_BATCH_SIZE);
    const currentProjectionByEntityId = new Map(
      currentProjections.map((projection) => [projection.entityId, projection]),
    );
    const queuedAt = new Date();
    const values = candidates.flatMap((candidate) => {
      const entity = lockedEntityById.get(candidate.entityId);
      const field = currentFieldById.get(candidate.fieldId);
      const projection = currentProjectionByEntityId.get(candidate.entityId);
      const hasCurrentProjection =
        projection !== undefined &&
        ((projection.sourceEntityVersionId === null &&
          projection.sourceFieldId === null &&
          projection.sourceFileId === null &&
          projection.sourceSha256Hex === null) ||
          (projection.sourceEntityVersionId === candidate.entityVersionId &&
            projection.sourceFieldId === candidate.fieldId &&
            projection.sourceFileId === candidate.content.id &&
            projection.sourceSha256Hex === candidate.content.sha256Hex));
      if (
        entity?.currentVersionId !== candidate.entityVersionId ||
        entity.workspaceId !== candidate.workspaceId ||
        entity.readOnly ||
        !field ||
        !isSameNativeExtractionSource(candidate, field)
      ) {
        return [];
      }
      if (hasCurrentProjection) {
        const failedAt = new Date();
        return [
          {
            id: createSafeId<"documentProcessingRun">(),
            entityId: candidate.entityId,
            entityVersionId: candidate.entityVersionId,
            errorAt: failedAt,
            errorCode: SEARCH_INDEX_FAILURE_CODE,
            fieldId: candidate.fieldId,
            kind: "native-extraction",
            nextAttemptAt: failedAt,
            organizationId: candidate.organizationId,
            processorVersion: DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
            requestedBy: null,
            requestSource: "repair",
            sourceFileId: candidate.content.id,
            sourceSha256Hex: candidate.content.sha256Hex,
            status: "failed",
            workspaceId: candidate.workspaceId,
          } satisfies typeof documentProcessingRuns.$inferInsert,
        ];
      }
      return [
        {
          id: createSafeId<"documentProcessingRun">(),
          entityId: candidate.entityId,
          entityVersionId: candidate.entityVersionId,
          fieldId: candidate.fieldId,
          kind: "native-extraction",
          // Due now rather than unscheduled, so the reconciliation tick
          // that created this run also delivers it: the delivery phase
          // runs last and selects scheduled work. Left unscheduled, the
          // run would sit queued until the dispatch scheduler noticed it,
          // which a batch worker may not outlive.
          nextAttemptAt: queuedAt,
          organizationId: candidate.organizationId,
          processorVersion: DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
          requestedBy: null,
          requestSource: "repair",
          sourceFileId: candidate.content.id,
          sourceSha256Hex: candidate.content.sha256Hex,
          workspaceId: candidate.workspaceId,
        } satisfies typeof documentProcessingRuns.$inferInsert,
      ];
    });
    if (values.length === 0) {
      return [];
    }

    const repairableConflict = sql.join(
      [
        eq(documentProcessingRuns.status, "cancelled"),
        inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
        inArray(documentProcessingRuns.errorCode, [
          SOURCE_SUPERSEDED_CANCELLATION_CODE,
          "workspace_unavailable",
        ]),
      ],
      sql` AND `,
    );
    const queued = await tx
      .insert(documentProcessingRuns)
      .values(values)
      .onConflictDoUpdate({
        target: [
          documentProcessingRuns.organizationId,
          documentProcessingRuns.kind,
          documentProcessingRuns.entityVersionId,
          documentProcessingRuns.fieldId,
          documentProcessingRuns.sourceFileId,
          documentProcessingRuns.sourceSha256Hex,
          documentProcessingRuns.processorVersion,
        ],
        set: {
          errorAt: sql`excluded.error_at`,
          errorCode: sql`excluded.error_code`,
          finishedAt: null,
          nextAttemptAt: sql`excluded.next_attempt_at`,
          requestSource: "repair",
          status: sql`excluded.status`,
          updatedAt: queuedAt,
        },
        setWhere: repairableConflict,
      })
      .returning({ id: documentProcessingRuns.id });
    return queued.map(({ id }) => id);
  });
};

type EnqueueAttemptResult =
  | {
      status: "enqueued";
      runId: SafeId<"documentProcessingRun">;
    }
  | {
      status: "failed";
      runId: SafeId<"documentProcessingRun">;
    };

export const tryEnqueueDocumentProcessingRun = async ({
  captureEnqueueError = captureError,
  enqueue = enqueueDocumentProcessingRun,
  runId,
  timeoutMs = QUEUE_HANDOFF_TIMEOUT_MS,
}: {
  captureEnqueueError?: typeof captureError;
  enqueue?: typeof enqueueDocumentProcessingRun;
  runId: SafeId<"documentProcessingRun">;
  timeoutMs?: number;
}): Promise<EnqueueAttemptResult> => {
  const result = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await enqueue(runId), {
        label: "document OCR queue handoff",
        timeoutMs,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    captureEnqueueError(result.error, { runId });
    return { runId, status: "failed" };
  }
  return { runId, status: "enqueued" };
};

/**
 * What one reconciliation phase reports for one tick. `count` is the
 * effect the phase had (runs created, rows recovered, deliveries
 * attempted); `hasMore` is the phase's own answer to "was there more than
 * I could take this tick". The two are independent: a phase can scan a
 * full page and act on none of it, so `count` can never stand in for
 * saturation.
 */
type ReconciliationPhaseResult = {
  count: number;
  hasMore: boolean;
};

export type DocumentProcessingReconciliationDependencies = {
  broadcastWorkspaceResourceUpdated: typeof broadcastWorkspaceResourceUpdated;
  database: typeof rootDb;
  enqueueDocumentProcessingRun: typeof enqueueDocumentProcessingRun;
  enqueueDocumentDeadlineScout: typeof enqueueDocumentDeadlineScout;
  indexEntity: (entityId: SafeId<"entity">) => Promise<void>;
  readRepairScanCursor: () => Promise<SafeId<"field"> | null>;
  readyRepairCursor: () => Promise<unknown>;
  writeRepairScanCursor: (input: {
    expectedCursor: SafeId<"field"> | null;
    nextCursor: SafeId<"field"> | null;
  }) => Promise<boolean>;
};

/** The two dependencies this sweep needs, so the scheduler can run it without
 *  assembling the whole reconciliation set and a test can drive it with a
 *  stubbed queue. */
type RecoverDocumentDeadlineScoutDispatchesOptions = {
  database?: DocumentProcessingReconciliationDependencies["database"];
  enqueueDocumentDeadlineScout?: DocumentProcessingReconciliationDependencies["enqueueDocumentDeadlineScout"];
};

/**
 * Return expired scout dispatches to `pending` and hand every pending one to
 * the scout queue.
 *
 * Exported because the scout worker and this dispatcher live in different
 * processes: the worker starts with the API server, while the reconciliation
 * loop that used to be the dispatcher's only driver runs in the document
 * processing worker. Wherever that worker is absent, `pending` rows had
 * nothing to dispatch them. The scheduler runs it too; the enqueue is keyed by
 * the source run, so the two drivers converge rather than duplicating work.
 */
export const recoverDocumentDeadlineScoutDispatches = async ({
  database = rootDb,
  enqueueDocumentDeadlineScout: enqueueScout = enqueueDocumentDeadlineScout,
}: RecoverDocumentDeadlineScoutDispatchesOptions = {}): Promise<ReconciliationPhaseResult> => {
  const staleBefore = new Date(Date.now() - DEADLINE_SCOUT_LEASE_TIMEOUT_MS);
  const staleDispatches = await database
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.deadlineScoutStatus, "running"),
        lt(documentProcessingRuns.deadlineScoutClaimedAt, staleBefore),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.deadlineScoutClaimedAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);
  // Compare-and-set on the state the select matched, not on the id alone.
  // This sweep runs in the scheduler and in the processing worker's own
  // reconciliation loop, so two of them can select the same expired dispatch.
  // Once the first resets it a worker claims a fresh attempt, and an id-only
  // update from the second would push that live claim back to `pending`: the
  // worker's settlement predicate then rejects its own result and the metered
  // scan is replayed on every later sweep. Re-asserting `running` and the same
  // expired claim makes the second update match nothing.
  const reclaimedDispatches =
    staleDispatches.length === 0
      ? []
      : await database
          .update(documentProcessingRuns)
          .set({
            deadlineScoutClaimedAt: null,
            deadlineScoutErrorCode: "worker_lease_expired",
            deadlineScoutStatus: "pending",
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(
                documentProcessingRuns.id,
                staleDispatches.map(({ id }) => id),
              ),
              eq(documentProcessingRuns.deadlineScoutStatus, "running"),
              lt(documentProcessingRuns.deadlineScoutClaimedAt, staleBefore),
            ),
          )
          .returning({ id: documentProcessingRuns.id });

  const staleCensusRuns = await database
    .select({ id: scoutRuns.id })
    .from(scoutRuns)
    .where(
      and(
        eq(scoutRuns.scoutKey, SCOUT_KEY.DOCUMENT_DEADLINES),
        eq(scoutRuns.status, SCOUT_RUN_STATUS.RUNNING),
        lt(scoutRuns.startedAt, staleBefore),
      ),
    )
    .orderBy(asc(scoutRuns.startedAt), asc(scoutRuns.id))
    .limit(RECONCILE_BATCH_SIZE);
  // Same compare-and-set, so a census run that restarted between the select
  // and this update is not retired out from under its worker.
  const failedCensusRuns =
    staleCensusRuns.length === 0
      ? []
      : await database
          .update(scoutRuns)
          .set({
            error: "worker_lease_expired",
            finishedAt: new Date(),
            status: SCOUT_RUN_STATUS.FAILED,
          })
          .where(
            and(
              inArray(
                scoutRuns.id,
                staleCensusRuns.map(({ id }) => id),
              ),
              eq(scoutRuns.status, SCOUT_RUN_STATUS.RUNNING),
              lt(scoutRuns.startedAt, staleBefore),
            ),
          )
          .returning({ id: scoutRuns.id });

  const pending = await database
    .select({ sourceRunId: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(eq(documentProcessingRuns.deadlineScoutStatus, "pending"))
    .orderBy(
      asc(documentProcessingRuns.updatedAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);

  const results = await mapWithConcurrency({
    items: pending,
    limit: DEADLINE_SCOUT_DISPATCH_CONCURRENCY,
    operation: async ({ sourceRunId }) =>
      await Result.tryPromise(async () => {
        await enqueueScout({ sourceRunId });
      }),
  });
  for (const result of results) {
    if (Result.isError(result)) {
      captureError(result.error, { operation: "deadline-scout-dispatch" });
    }
  }

  return {
    // Rows actually transitioned, not rows selected: a candidate another
    // sweep already reclaimed is not this sweep's effect.
    count:
      reclaimedDispatches.length +
      failedCensusRuns.length +
      results.filter(Result.isOk).length,
    hasMore:
      cappedSelectionHasMore({
        limit: RECONCILE_BATCH_SIZE,
        selected: pending.length,
      }) ||
      cappedSelectionHasMore({
        limit: RECONCILE_BATCH_SIZE,
        selected: staleDispatches.length,
      }) ||
      cappedSelectionHasMore({
        limit: RECONCILE_BATCH_SIZE,
        selected: staleCensusRuns.length,
      }),
  };
};

/**
 * A capped selection that came back full stopped at the cap, not at the
 * end of the backlog. Every phase computes this from the rows it selected,
 * beside the `.limit()` that capped them.
 */
const cappedSelectionHasMore = ({
  limit,
  selected,
}: {
  limit: number;
  selected: number;
}): boolean => selected >= limit;

type RepairScanPage = ReconciliationPhaseResult & {
  nextCursor: SafeId<"field"> | null;
};

/**
 * The repair sweep's resume position and its backlog are the same fact:
 * a full page means the scan stopped at the cap, so the next tick resumes
 * after the last scanned field; a short page means it reached the end of
 * the table, so the cursor resets and this phase has nothing more to take.
 * The runs the page created are not part of it: they are due input for the
 * reindex and delivery phases, which run later in the same tick, and their
 * own signals answer for them. Derived together so cursor and signal
 * cannot disagree, and never from the created-run count, which most
 * scanned fields never reach.
 */
export const resolveRepairScanPage = ({
  createdRunCount,
  scannedFieldIds,
}: {
  createdRunCount: number;
  scannedFieldIds: readonly SafeId<"field">[];
}): RepairScanPage => {
  const scanSaturated = cappedSelectionHasMore({
    limit: RECONCILE_BATCH_SIZE,
    selected: scannedFieldIds.length,
  });
  return {
    count: createdRunCount,
    hasMore: scanSaturated,
    nextCursor: scanSaturated ? (scannedFieldIds.at(-1) ?? null) : null,
  };
};

// Return types are inferred so each producer's own `hasMore` reasoning
// stays visible at the `return`, and the `ReconciliationPhase` contract
// checks the shape where the phases are declared.
const recoverMissingNativeExtractionRuns = async (
  dependencies: DocumentProcessingReconciliationDependencies,
) => {
  // Take the connection before the cursor commands rather than inside
  // them: their deadlines bound command latency and are far shorter than a
  // cold-start retry ladder. A connect that fails here fails this phase,
  // which is the only phase that needs Redis at all; the rest of the tick
  // runs on the database alone and is not held to this.
  await dependencies.readyRepairCursor();
  const settledBefore = new Date(Date.now() - REPAIR_SETTLE_DELAY_MS);
  const cursor = await dependencies.readRepairScanCursor();
  const candidates = await dependencies.database
    .select({
      content: fields.content,
      entityId: entities.id,
      entityVersionId: entityVersions.id,
      fieldId: fields.id,
      organizationId: workspaces.organizationId,
      workspaceId: workspaces.id,
    })
    .from(fields)
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, fields.entityVersionId),
        eq(entityVersions.workspaceId, fields.workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      entities,
      and(
        eq(entities.currentVersionId, entityVersions.id),
        eq(entities.id, entityVersions.entityId),
        eq(entities.workspaceId, fields.workspaceId),
        eq(entities.readOnly, false),
      ),
    )
    .innerJoin(workspaces, eq(workspaces.id, fields.workspaceId))
    .where(
      and(
        cursor === null ? undefined : gt(fields.id, cursor),
        lt(entityVersions.createdAt, settledBefore),
        eq(workspaces.status, "active"),
        sql`${fields.content}->>'type' = 'file'
          AND ${fields.content}->>'encrypted' = 'false'`,
        notExists(
          dependencies.database
            .select({ id: earlierFileFields.id })
            .from(earlierFileFields)
            .where(
              and(
                eq(earlierFileFields.workspaceId, fields.workspaceId),
                eq(earlierFileFields.entityVersionId, fields.entityVersionId),
                lt(earlierFileFields.id, fields.id),
                sql`${earlierFileFields.content}->>'type' = 'file'`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(fields.id))
    .limit(RECONCILE_BATCH_SIZE);

  if (candidates.length === 0) {
    if (cursor !== null) {
      await dependencies.writeRepairScanCursor({
        expectedCursor: cursor,
        nextCursor: null,
      });
    }
    return { count: 0, hasMore: false };
  }

  const repairCandidates = candidates.flatMap((candidate) => {
    if (
      candidate.content.type !== "file" ||
      !requiresDurableNativeExtraction(candidate.content)
    ) {
      return [];
    }
    return [{ ...candidate, content: candidate.content }];
  });
  const runIds = await persistMissingNativeExtractionRuns(
    repairCandidates,
    dependencies.database,
  );
  const page = resolveRepairScanPage({
    createdRunCount: runIds.length,
    scannedFieldIds: candidates.map(({ fieldId }) => fieldId),
  });
  await dependencies.writeRepairScanCursor({
    expectedCursor: cursor,
    nextCursor: page.nextCursor,
  });
  return { count: page.count, hasMore: page.hasMore };
};

const updateQueuedRunSchedule = async ({
  database,
  delayMs,
  runIds,
  updatedAt,
}: {
  database: typeof rootDb;
  delayMs: number;
  runIds: SafeId<"documentProcessingRun">[];
  updatedAt: Date;
}): Promise<void> => {
  if (runIds.length === 0) {
    return;
  }
  await database
    .update(documentProcessingRuns)
    .set({
      nextAttemptAt: new Date(updatedAt.getTime() + delayMs),
      updatedAt,
    })
    .where(
      and(
        inArray(documentProcessingRuns.id, runIds),
        eq(documentProcessingRuns.status, "queued"),
      ),
    );
};

export const dispatchQueuedDocumentProcessingRuns = async ({
  database = rootDb,
  enqueue = enqueueDocumentProcessingRun,
  limit = RECONCILE_BATCH_SIZE,
  selection = QUEUED_OCR_SELECTION.ALL_DUE,
}: {
  database?: typeof rootDb;
  enqueue?: typeof enqueueDocumentProcessingRun;
  limit?: number;
  selection?:
    | typeof QUEUED_OCR_SELECTION.ALL_DUE
    | typeof QUEUED_OCR_SELECTION.SCHEDULED_RETRIES;
} = {}): Promise<{
  attempted: number;
  hasMore: boolean;
  retryAt: Date | null;
}> => {
  const now = new Date();
  const runs = await database
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.status, "queued"),
        selection === QUEUED_OCR_SELECTION.SCHEDULED_RETRIES
          ? isNotNull(documentProcessingRuns.nextAttemptAt)
          : undefined,
        or(
          isNull(documentProcessingRuns.nextAttemptAt),
          lte(documentProcessingRuns.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(
      sql`${documentProcessingRuns.nextAttemptAt} ASC NULLS FIRST`,
      asc(documentProcessingRuns.createdAt),
      asc(documentProcessingRuns.id),
    )
    .limit(limit);

  const attempts = await Promise.all(
    runs.map(
      async ({ id }) =>
        await tryEnqueueDocumentProcessingRun({ enqueue, runId: id }),
    ),
  );
  const enqueuedIds: SafeId<"documentProcessingRun">[] = [];
  const failedIds: SafeId<"documentProcessingRun">[] = [];
  for (const attempt of attempts) {
    switch (attempt.status) {
      case "enqueued":
        enqueuedIds.push(attempt.runId);
        break;
      case "failed":
        failedIds.push(attempt.runId);
        break;
      default:
        attempt satisfies never;
        panic(`Unhandled attempt: ${String(attempt)}`);
    }
  }

  const updatedAt = new Date();
  await updateQueuedRunSchedule({
    database,
    delayMs: ENQUEUE_VISIBILITY_TIMEOUT_MS,
    runIds: enqueuedIds,
    updatedAt,
  });
  await updateQueuedRunSchedule({
    database,
    delayMs: ENQUEUE_FAILURE_RETRY_MS,
    runIds: failedIds,
    updatedAt,
  });
  return {
    attempted: runs.length,
    hasMore: cappedSelectionHasMore({ limit, selected: runs.length }),
    retryAt:
      failedIds.length === 0
        ? null
        : new Date(updatedAt.getTime() + ENQUEUE_FAILURE_RETRY_MS),
  };
};

/**
 * A run whose handoff failed is still queued and still nobody else's work:
 * it comes back to this phase on a later tick, so the phase order cannot
 * cover it and the phase reports it itself.
 */
export const resolveScheduledDeliveryBatch = ({
  attempted,
  retryAt,
  saturated,
}: {
  attempted: number;
  retryAt: Date | null;
  saturated: boolean;
}): ReconciliationPhaseResult => ({
  count: attempted,
  hasMore: saturated || retryAt !== null,
});

const dispatchScheduledDocumentProcessingRetries = async (
  dependencies: DocumentProcessingReconciliationDependencies,
) => {
  const { attempted, hasMore, retryAt } =
    await dispatchQueuedDocumentProcessingRuns({
      database: dependencies.database,
      enqueue: dependencies.enqueueDocumentProcessingRun,
      selection: QUEUED_OCR_SELECTION.SCHEDULED_RETRIES,
    });
  return resolveScheduledDeliveryBatch({
    attempted,
    retryAt,
    saturated: hasMore,
  });
};

// Manual searchable-PDF failures are retryable too, so the condition spans
// both automatic OCR sources and every derivative failure.
const retryableOcrFailureCondition = () =>
  or(
    and(
      inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
      inArray(documentProcessingRuns.errorCode, retryableOcrFailureCodes),
    ),
    eq(documentProcessingRuns.errorCode, SEARCHABLE_PDF_FAILURE_CODE),
  );

const recoverRetryableOcrFailures = async (
  dependencies: DocumentProcessingReconciliationDependencies,
) => {
  const now = new Date();
  const retryableRuns = await dependencies.database
    .select({
      attemptCount: documentProcessingRuns.attemptCount,
      id: documentProcessingRuns.id,
      nextAttemptAtToken: timestampCasToken(
        documentProcessingRuns.nextAttemptAt,
      ),
    })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.status, "failed"),
        retryableOcrFailureCondition(),
        lt(documentProcessingRuns.attemptCount, AUTOMATIC_OCR_MAX_ATTEMPTS),
        or(
          isNull(documentProcessingRuns.nextAttemptAt),
          lte(documentProcessingRuns.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.nextAttemptAt),
      asc(documentProcessingRuns.createdAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);
  // Only the selection is capped; the compare-and-set below can recover
  // fewer rows than it read, which says nothing about the backlog.
  const hasMore = cappedSelectionHasMore({
    limit: RECONCILE_BATCH_SIZE,
    selected: retryableRuns.length,
  });
  if (retryableRuns.length === 0) {
    return { count: 0, hasMore };
  }

  const capturedSchedules = or(
    ...retryableRuns.map(({ attemptCount, id, nextAttemptAtToken }) =>
      and(
        eq(documentProcessingRuns.id, id),
        eq(documentProcessingRuns.attemptCount, attemptCount),
        nextAttemptAtToken === null
          ? isNull(documentProcessingRuns.nextAttemptAt)
          : timestampMatchesCasToken(
              documentProcessingRuns.nextAttemptAt,
              nextAttemptAtToken,
            ),
      ),
    ),
  );
  if (!capturedSchedules) {
    return { count: 0, hasMore };
  }

  const recovered = await dependencies.database
    .update(documentProcessingRuns)
    .set({
      nextAttemptAt: now,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.status, "failed"),
        retryableOcrFailureCondition(),
        capturedSchedules,
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return { count: recovered.length, hasMore };
};

type FailedSearchIndexCandidate = {
  attemptCount: number;
  claimToken: string;
  entityId: SafeId<"entity">;
  id: SafeId<"documentProcessingRun">;
  workspaceId: SafeId<"workspace">;
};

const searchIndexProjectionSourceFields = alias(
  fields,
  "document_processing_search_index_projection_source_fields",
);

export const runSearchIndexReplayAttempt = async ({
  indexEntity,
  onFailure,
  onSuccess,
  timeoutMs = SEARCH_INDEX_ATTEMPT_TIMEOUT_MS,
  transitionTimeoutMs = SEARCH_INDEX_REPLAY_STATE_TRANSITION_TIMEOUT_MS,
}: {
  indexEntity: () => Promise<void>;
  onFailure: (error: unknown) => Promise<void>;
  onSuccess: () => Promise<boolean>;
  timeoutMs?: number;
  transitionTimeoutMs?: number;
}): Promise<boolean> => {
  const indexed = await Result.tryPromise({
    try: async () =>
      await withTimeout(indexEntity, {
        label: "document OCR search-index replay",
        timeoutMs,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(indexed)) {
    await withTimeout(async () => await onFailure(indexed.error), {
      label: "document OCR search-index replay failure transition",
      timeoutMs: transitionTimeoutMs,
    });
    return false;
  }
  return await withTimeout(onSuccess, {
    label: "document OCR search-index replay success transition",
    timeoutMs: transitionTimeoutMs,
  });
};

const recoverFailedSearchIndex = async (
  {
    attemptCount,
    claimToken,
    entityId,
    id,
    workspaceId,
  }: FailedSearchIndexCandidate,
  dependencies: DocumentProcessingReconciliationDependencies,
): Promise<boolean> =>
  await runSearchIndexReplayAttempt({
    indexEntity: async () => await dependencies.indexEntity(entityId),
    onFailure: async (error) => {
      captureError(error, { entityId, runId: id });
      await dependencies.database
        .update(documentProcessingRuns)
        .set({
          attemptCount: sql`${documentProcessingRuns.attemptCount} + 1`,
          claimedAt: null,
          claimedBy: null,
          errorAt: new Date(),
          errorCode: SEARCH_INDEX_FAILURE_CODE,
          nextAttemptAt: new Date(
            Date.now() + automaticOcrRetryDelayMs(attemptCount + 1),
          ),
          status: "failed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentProcessingRuns.id, id),
            eq(documentProcessingRuns.status, "running"),
            eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
            eq(documentProcessingRuns.attemptCount, attemptCount),
            eq(documentProcessingRuns.claimedBy, claimToken),
          ),
        );
    },
    onSuccess: async () => {
      const completed = await dependencies.database
        .update(documentProcessingRuns)
        .set({
          claimedAt: null,
          claimedBy: null,
          errorAt: null,
          errorCode: null,
          finishedAt: new Date(),
          nextAttemptAt: null,
          status: "succeeded",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentProcessingRuns.id, id),
            eq(documentProcessingRuns.status, "running"),
            eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
            eq(documentProcessingRuns.attemptCount, attemptCount),
            eq(documentProcessingRuns.claimedBy, claimToken),
          ),
        )
        .returning({ id: documentProcessingRuns.id });
      if (!completed.at(0)) {
        return false;
      }

      dependencies.broadcastWorkspaceResourceUpdated(
        workspaceId,
        resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
      );
      return true;
    },
  });

/**
 * A replay this phase claimed and did not complete went back to `failed`
 * with a backoff, which is this phase's own input again: no later phase
 * selects it, so the phase order cannot cover it and the phase reports it
 * itself. Claims lost to another worker are that worker's problem and are
 * not counted here.
 */
export const resolveSearchIndexReplayBatch = ({
  claimedCount,
  recoveredCount,
  saturated,
}: {
  claimedCount: number;
  recoveredCount: number;
  saturated: boolean;
}): ReconciliationPhaseResult => ({
  count: recoveredCount,
  hasMore: saturated || recoveredCount < claimedCount,
});

const recoverFailedOcrSearchIndexes = async (
  dependencies: DocumentProcessingReconciliationDependencies,
) => {
  const now = new Date();
  // The failed run is the durable retry token, but the entity projection is
  // the indexing source of truth. Automatic OCR may have preserved valid text
  // from another current field, so replay validates that projection's own
  // provenance instead of requiring it to match the failed run's source.
  const candidates = await dependencies.database
    .select({
      attemptCount: documentProcessingRuns.attemptCount,
      entityId: documentProcessingRuns.entityId,
      id: documentProcessingRuns.id,
      nextAttemptAtToken: timestampCasToken(
        documentProcessingRuns.nextAttemptAt,
      ),
      workspaceId: documentProcessingRuns.workspaceId,
    })
    .from(documentProcessingRuns)
    .innerJoin(
      extractedContent,
      and(
        eq(
          extractedContent.organizationId,
          documentProcessingRuns.organizationId,
        ),
        eq(extractedContent.workspaceId, documentProcessingRuns.workspaceId),
        eq(extractedContent.entityId, documentProcessingRuns.entityId),
      ),
    )
    .innerJoin(
      entities,
      and(
        eq(entities.id, documentProcessingRuns.entityId),
        eq(entities.workspaceId, documentProcessingRuns.workspaceId),
        eq(entities.currentVersionId, documentProcessingRuns.entityVersionId),
      ),
    )
    .leftJoin(
      searchIndexProjectionSourceFields,
      and(
        eq(
          searchIndexProjectionSourceFields.id,
          extractedContent.sourceFieldId,
        ),
        eq(
          searchIndexProjectionSourceFields.workspaceId,
          extractedContent.workspaceId,
        ),
        eq(
          searchIndexProjectionSourceFields.entityVersionId,
          entities.currentVersionId,
        ),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, documentProcessingRuns.workspaceId),
        eq(workspaces.organizationId, documentProcessingRuns.organizationId),
        eq(workspaces.status, "active"),
      ),
    )
    .where(
      and(
        eq(documentProcessingRuns.status, "failed"),
        eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
        or(
          and(
            isNull(extractedContent.sourceEntityVersionId),
            isNull(extractedContent.sourceFieldId),
            isNull(extractedContent.sourceFileId),
            isNull(extractedContent.sourceSha256Hex),
          ),
          and(
            eq(
              extractedContent.sourceEntityVersionId,
              entities.currentVersionId,
            ),
            sql`${searchIndexProjectionSourceFields.content}->>'type' = 'file'
              AND ${searchIndexProjectionSourceFields.content}->>'id' = ${extractedContent.sourceFileId}::text
              AND ${searchIndexProjectionSourceFields.content}->>'sha256Hex' = ${extractedContent.sourceSha256Hex}`,
          ),
        ),
        or(
          isNull(documentProcessingRuns.nextAttemptAt),
          lte(documentProcessingRuns.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.nextAttemptAt),
      asc(documentProcessingRuns.createdAt),
      asc(documentProcessingRuns.id),
    )
    .limit(SEARCH_INDEX_REPLAY_BATCH_SIZE);

  // A replay that fails is rescheduled with backoff, so it is not work
  // this phase could still take; only a full selection means more replays
  // were due than one batch could claim.
  const hasMore = cappedSelectionHasMore({
    limit: SEARCH_INDEX_REPLAY_BATCH_SIZE,
    selected: candidates.length,
  });
  if (candidates.length === 0) {
    return { count: 0, hasMore };
  }
  const capturedSchedules = or(
    ...candidates.map(({ attemptCount, id, nextAttemptAtToken }) =>
      and(
        eq(documentProcessingRuns.id, id),
        eq(documentProcessingRuns.attemptCount, attemptCount),
        nextAttemptAtToken === null
          ? isNull(documentProcessingRuns.nextAttemptAt)
          : timestampMatchesCasToken(
              documentProcessingRuns.nextAttemptAt,
              nextAttemptAtToken,
            ),
      ),
    ),
  );
  if (!capturedSchedules) {
    return { count: 0, hasMore };
  }

  const claimToken = `search-index-replay:${Bun.randomUUIDv7()}`;
  const claimed = await dependencies.database
    .update(documentProcessingRuns)
    .set({
      claimedAt: new Date(),
      claimedBy: claimToken,
      status: "running",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.status, "failed"),
        eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
        capturedSchedules,
      ),
    )
    .returning({
      attemptCount: documentProcessingRuns.attemptCount,
      entityId: documentProcessingRuns.entityId,
      id: documentProcessingRuns.id,
      workspaceId: documentProcessingRuns.workspaceId,
    });
  const recovered = await mapWithConcurrency({
    items: claimed.map((candidate) => ({
      attemptCount: candidate.attemptCount,
      claimToken,
      entityId: candidate.entityId,
      id: candidate.id,
      workspaceId: candidate.workspaceId,
    })),
    limit: SEARCH_INDEX_REPLAY_CONCURRENCY,
    operation: async (candidate) =>
      await recoverFailedSearchIndex(candidate, dependencies),
  });
  return resolveSearchIndexReplayBatch({
    claimedCount: claimed.length,
    recoveredCount: recovered.filter(Boolean).length,
    saturated: hasMore,
  });
};

const recoverStaleDocumentProcessingRuns = async (
  dependencies: DocumentProcessingReconciliationDependencies,
) => {
  const staleBefore = new Date(Date.now() - WORKER_LEASE_TIMEOUT_MS);
  const recoveredAt = new Date();
  const staleRuns = await dependencies.database
    .select({
      attemptCount: documentProcessingRuns.attemptCount,
      errorCode: documentProcessingRuns.errorCode,
      id: documentProcessingRuns.id,
      requestSource: documentProcessingRuns.requestSource,
    })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.status, "running"),
        lt(documentProcessingRuns.claimedAt, staleBefore),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.claimedAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);
  // The three updates below act on subsets of this selection, so their
  // combined row count tracks the effect, not the remaining backlog.
  const hasMore = cappedSelectionHasMore({
    limit: RECONCILE_BATCH_SIZE,
    selected: staleRuns.length,
  });
  if (staleRuns.length === 0) {
    return { count: 0, hasMore };
  }

  const exhaustedAutomaticIds = staleRuns.flatMap((run) =>
    shouldFailStaleAutomaticOcrRun(run) ? [run.id] : [],
  );
  const searchReplayIds = staleRuns.flatMap((run) =>
    run.errorCode === SEARCH_INDEX_FAILURE_CODE ? [run.id] : [],
  );
  const exhausted =
    exhaustedAutomaticIds.length === 0
      ? []
      : await dependencies.database
          .update(documentProcessingRuns)
          .set({
            claimedAt: null,
            claimedBy: null,
            errorAt: new Date(),
            errorCode: "worker_lease_expired",
            finishedAt: new Date(),
            nextAttemptAt: null,
            status: "failed",
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(documentProcessingRuns.id, exhaustedAutomaticIds),
              inArray(documentProcessingRuns.requestSource, [
                "upload",
                "repair",
              ]),
              eq(documentProcessingRuns.status, "running"),
              gte(
                documentProcessingRuns.attemptCount,
                AUTOMATIC_OCR_MAX_ATTEMPTS,
              ),
              sql`${documentProcessingRuns.errorCode} IS DISTINCT FROM ${SEARCH_INDEX_FAILURE_CODE}`,
              lt(documentProcessingRuns.claimedAt, staleBefore),
            ),
          )
          .returning({ id: documentProcessingRuns.id });
  const searchReplays =
    searchReplayIds.length === 0
      ? []
      : await dependencies.database
          .update(documentProcessingRuns)
          .set({
            claimedAt: null,
            claimedBy: null,
            errorAt: new Date(),
            errorCode: SEARCH_INDEX_FAILURE_CODE,
            nextAttemptAt: null,
            status: "failed",
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(documentProcessingRuns.id, searchReplayIds),
              eq(documentProcessingRuns.status, "running"),
              eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
              lt(documentProcessingRuns.claimedAt, staleBefore),
            ),
          )
          .returning({ id: documentProcessingRuns.id });
  const ids = staleRuns.map(({ id }) => id);
  const recovered = await dependencies.database
    .update(documentProcessingRuns)
    .set({
      claimedAt: null,
      claimedBy: null,
      errorAt: new Date(),
      errorCode: "worker_lease_expired",
      nextAttemptAt: recoveredAt,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(documentProcessingRuns.id, ids),
        eq(documentProcessingRuns.status, "running"),
        sql`${documentProcessingRuns.errorCode} IS DISTINCT FROM ${SEARCH_INDEX_FAILURE_CODE}`,
        lt(documentProcessingRuns.claimedAt, staleBefore),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return {
    count: exhausted.length + searchReplays.length + recovered.length,
    hasMore,
  };
};

const handleDocumentProcessingFailure = ({
  error,
  job,
}: {
  error: unknown;
  job: { data: DocumentProcessingJobData } | undefined;
}): void => {
  // No capture here: run-scoped failures capture once at their terminal
  // transition in `markRunFailed`, which is also where they are logged, so a
  // settled attempt is left alone. A dropped Redis socket on the claim path
  // heals on the job's own retry. Only machinery that failed before a run was
  // claimed has no other reporter, so only it stays on the ERROR log.
  const report = documentProcessingFailureReport(error);
  switch (report) {
    case DOCUMENT_PROCESSING_FAILURE_REPORT.ALREADY_REPORTED:
      return;
    case DOCUMENT_PROCESSING_FAILURE_REPORT.TRANSIENT_CONNECTION:
      logger.warn("document_processing.job_disrupted", {
        "error.type": errorTag(error),
        runId: job?.data.runId ?? "",
      });
      return;
    case DOCUMENT_PROCESSING_FAILURE_REPORT.MACHINERY:
      logger.error("document_processing.failed", {
        ...documentProcessingFailureFields(error),
        runId: job?.data.runId ?? "",
      });
      return;
    default:
      report satisfies never;
      panic(`Unhandled report: ${String(report)}`);
  }
};

const RECONCILIATION_PHASE = {
  DEADLINE_SCOUT: "deadline-scout",
  DELIVERY: "delivery",
  REINDEX: "reindex",
  REPAIR: "repair",
  RETRY: "retry",
  STALE_LEASE: "stale-lease",
} as const;

type ReconciliationPhaseName =
  (typeof RECONCILIATION_PHASE)[keyof typeof RECONCILIATION_PHASE];

type ReconciliationResults = Record<
  ReconciliationPhaseName,
  ReconciliationPhaseResult
>;

type ReconciliationPhase = {
  name: ReconciliationPhaseName;
  run: () => Promise<ReconciliationPhaseResult>;
};

const RECONCILIATION_PHASE_NAMES = Object.values(RECONCILIATION_PHASE);

const DEFAULT_RECONCILIATION_DEPENDENCIES = {
  broadcastWorkspaceResourceUpdated,
  database: rootDb,
  enqueueDocumentDeadlineScout,
  enqueueDocumentProcessingRun,
  indexEntity: async (entityId: SafeId<"entity">) =>
    await getSearchProvider().indexEntity(entityId),
  readRepairScanCursor: async () => await readRepairScanCursor(),
  readyRepairCursor: async () => await reconciliationRedis.ready(),
  writeRepairScanCursor: async (input: {
    expectedCursor: SafeId<"field"> | null;
    nextCursor: SafeId<"field"> | null;
  }) => await writeRepairScanCursor(input),
} satisfies DocumentProcessingReconciliationDependencies;

/** Total by type: a declared phase cannot exist without a producer. */
const createReconciliationPhaseRunners = (
  dependencies: DocumentProcessingReconciliationDependencies,
) =>
  ({
    [RECONCILIATION_PHASE.DEADLINE_SCOUT]: async () =>
      await recoverDocumentDeadlineScoutDispatches(dependencies),
    [RECONCILIATION_PHASE.DELIVERY]: async () =>
      await dispatchScheduledDocumentProcessingRetries(dependencies),
    [RECONCILIATION_PHASE.REINDEX]: async () =>
      await recoverFailedOcrSearchIndexes(dependencies),
    [RECONCILIATION_PHASE.REPAIR]: async () =>
      await recoverMissingNativeExtractionRuns(dependencies),
    [RECONCILIATION_PHASE.RETRY]: async () =>
      await recoverRetryableOcrFailures(dependencies),
    [RECONCILIATION_PHASE.STALE_LEASE]: async () =>
      await recoverStaleDocumentProcessingRuns(dependencies),
  }) satisfies Record<ReconciliationPhaseName, ReconciliationPhase["run"]>;

/**
 * Which phases each phase's transitions feed, read off its writes against
 * every phase's selection predicate. A produced row counts as an edge only
 * when the consumer would select it in the same tick, so future-scheduled
 * rows (a replay backed off, a handoff rescheduled, an enqueued run parked
 * behind its visibility timeout) are not edges here.
 *
 * - repair inserts queued runs due now (delivery selects queued rows with
 *   a due schedule) and, where a current projection already exists, failed
 *   runs coded `search_index_failed` and due now (reindex selects those).
 * - retry moves retryable failures to queued, due now: delivery.
 * - stale-lease returns expired leases to queued, due now (delivery), and
 *   expired search-index replays to failed, `search_index_failed`,
 *   unscheduled, which reindex selects. Its exhausted-attempt writes carry
 *   `worker_lease_expired` past the attempt cap, which no phase selects.
 * - reindex claims rows for itself; what it does not complete comes back
 *   to reindex with a backoff, and what it completes is terminal.
 * - delivery only moves rows into the job queue or reschedules them for a
 *   later delivery.
 *
 * Work a phase leaves for itself is not listed: no ordering can help it,
 * so that phase reports it in its own `hasMore` instead.
 */
export const DOCUMENT_PROCESSING_RECONCILIATION_PHASE_FEEDS = {
  [RECONCILIATION_PHASE.DEADLINE_SCOUT]: [],
  [RECONCILIATION_PHASE.DELIVERY]: [],
  [RECONCILIATION_PHASE.REINDEX]: [],
  [RECONCILIATION_PHASE.REPAIR]: [
    RECONCILIATION_PHASE.REINDEX,
    RECONCILIATION_PHASE.DELIVERY,
  ],
  [RECONCILIATION_PHASE.RETRY]: [RECONCILIATION_PHASE.DELIVERY],
  [RECONCILIATION_PHASE.STALE_LEASE]: [
    RECONCILIATION_PHASE.REINDEX,
    RECONCILIATION_PHASE.DELIVERY,
  ],
} as const satisfies Record<
  ReconciliationPhaseName,
  readonly ReconciliationPhaseName[]
>;

/**
 * The phases the worker actually runs, in the order those edges force:
 * every producer ahead of every phase it feeds, so work a tick creates is
 * taken by the same tick rather than waiting for the next one. Repair and
 * stale-lease both feed reindex, all three of repair, retry and stale-lease
 * feed delivery, and reindex and delivery feed nobody, which leaves repair,
 * retry, stale-lease, reindex, delivery. Assembled from the runner map
 * rather than written out again, so the only way to leave a declared phase
 * unrun is to leave it out of this order, which the reconciliation tests
 * check against both the declared names and the edges above.
 */
const RECONCILIATION_PHASE_ORDER = [
  RECONCILIATION_PHASE.DEADLINE_SCOUT,
  RECONCILIATION_PHASE.REPAIR,
  RECONCILIATION_PHASE.RETRY,
  RECONCILIATION_PHASE.STALE_LEASE,
  RECONCILIATION_PHASE.REINDEX,
  RECONCILIATION_PHASE.DELIVERY,
] as const;

export const createDocumentProcessingReconciliationPhases = (
  dependencies: DocumentProcessingReconciliationDependencies,
): readonly ReconciliationPhase[] => {
  const runners = createReconciliationPhaseRunners(dependencies);
  return RECONCILIATION_PHASE_ORDER.map((name) => ({
    name,
    run: runners[name],
  }));
};

export const DOCUMENT_PROCESSING_RECONCILIATION_PHASES =
  createDocumentProcessingReconciliationPhases(
    DEFAULT_RECONCILIATION_DEPENDENCIES,
  );

/**
 * Whether the tick stopped short of draining every backlog. Each phase
 * states its own saturation, so this only has to collect the answers: no
 * count is reinterpreted here, because effect counts (runs created, rows
 * recovered) are routinely smaller than the rows a phase read.
 */
export const reconciliationLeftWorkBehind = (
  results: ReconciliationResults,
): boolean =>
  RECONCILIATION_PHASE_NAMES.some((phase) => results[phase].hasMore);

const reconciliationProgress = createReconciliationProgress();

/**
 * Whether the latest reconciliation tick left work behind, waiting for a
 * tick in flight to report. Batch mode reads this so the worker does not
 * treat an empty job queue as "nothing left to do" while the
 * reconciliation loop is still draining a backlog one capped batch at a
 * time.
 */
export const hasUnfinishedDocumentProcessingReconciliation =
  reconciliationProgress.hasUnfinishedWork;

/** Companion synchronous reads for the idle sampler's decision frame. */
export const isDocumentProcessingReconciliationInFlight =
  reconciliationProgress.isTickRunning;

export const documentProcessingReconciliationGeneration =
  reconciliationProgress.tickGeneration;

export const runDocumentProcessingReconciliationPhases = async ({
  onPhaseError,
  phases,
}: {
  onPhaseError: (error: unknown, phase: ReconciliationPhaseName) => void;
  phases: readonly ReconciliationPhase[];
}): Promise<ReconciliationResults> => {
  const drained = (): ReconciliationPhaseResult => ({
    count: 0,
    hasMore: false,
  });
  const results: ReconciliationResults = {
    [RECONCILIATION_PHASE.DEADLINE_SCOUT]: drained(),
    [RECONCILIATION_PHASE.DELIVERY]: drained(),
    [RECONCILIATION_PHASE.REINDEX]: drained(),
    [RECONCILIATION_PHASE.REPAIR]: drained(),
    [RECONCILIATION_PHASE.RETRY]: drained(),
    [RECONCILIATION_PHASE.STALE_LEASE]: drained(),
  };
  for (const phase of phases) {
    const result = await Result.tryPromise({
      // Called through an arrow rather than passed by reference: a phase
      // is defined as taking nothing, and handing the reference over lets
      // whatever the caller supplies land in a parameter the phase never
      // asked for.
      try: async () => await phase.run(),
      catch: (cause) => cause,
    });
    if (Result.isError(result)) {
      onPhaseError(result.error, phase.name);
      // A phase that failed drained nothing it can prove, so its backlog
      // is unknown: report it as work left behind rather than as drained.
      results[phase.name] = { count: 0, hasMore: true };
      continue;
    }
    results[phase.name] = result.value;
  }
  return results;
};

const reconcileDocumentProcessing = async ({
  onComplete,
}: {
  onComplete: () => void;
}): Promise<void> => {
  try {
    // Marks reconciliation unfinished before the first await, so the idle
    // sampler sees an in-flight tick as work in progress no matter how
    // long the tick runs or where a sample lands inside it.
    await reconciliationProgress.runTick(async () => {
      const results = await runDocumentProcessingReconciliationPhases({
        phases: DOCUMENT_PROCESSING_RECONCILIATION_PHASES,
        onPhaseError: (error, phase) => {
          // A dropped Redis socket rejects the first command after an idle
          // window; the next 30s tick retries the phase, so the transient
          // stays a structured log instead of an exception.
          if (isTransientRedisConnectionError(error)) {
            logger.warn("document_processing.reconcile_phase_disrupted", {
              "error.type": errorTag(error),
              phase,
            });
            return;
          }
          captureError(error, { phase });
          logger.error("document_processing.reconcile_phase_failed", {
            ...errorSystemFields(error),
            phase,
          });
        },
      });
      if (
        RECONCILIATION_PHASE_NAMES.some((phase) => results[phase].count > 0)
      ) {
        logger.info("document_processing.reconciled", {
          deadlineScoutDispatchedCount: String(
            results[RECONCILIATION_PHASE.DEADLINE_SCOUT].count,
          ),
          deliveredCount: String(results[RECONCILIATION_PHASE.DELIVERY].count),
          recoveredCount: String(
            results[RECONCILIATION_PHASE.STALE_LEASE].count,
          ),
          reindexedCount: String(results[RECONCILIATION_PHASE.REINDEX].count),
          repairedCount: String(results[RECONCILIATION_PHASE.REPAIR].count),
          retriedCount: String(results[RECONCILIATION_PHASE.RETRY].count),
        });
      }
      return reconciliationLeftWorkBehind(results);
    });
  } catch (error) {
    // The tick never reported, so the backlog stays unknown and
    // `runTick` leaves reconciliation marked unfinished. Same rule the
    // idle check applies to a failed sample: never exit on uncertainty.
    if (isTransientRedisConnectionError(error)) {
      logger.warn("document_processing.reconcile_disrupted", {
        "error.type": errorTag(error),
      });
    } else {
      captureError(error);
      logger.error(
        "document_processing.reconcile_failed",
        errorSystemFields(error),
      );
    }
  } finally {
    onComplete();
  }
};

export const abortDocumentProcessingWorkerBeforeClose = async ({
  abortLifecycle,
  closeWorker,
}: {
  abortLifecycle: () => void;
  closeWorker: () => Promise<void>;
}): Promise<void> => {
  abortLifecycle();
  await closeWorker();
};

export const initDocumentProcessingWorker = () => {
  const lifecycle = new AbortController();
  const ocrConfigured = isLocalDocumentOcrConfigured();

  const worker = new Worker<DocumentProcessingJobData>(
    DOCUMENT_PROCESSING_QUEUE_NAME,
    async (job) => {
      try {
        await processDocumentProcessingRun(job.data.runId, lifecycle.signal);
      } catch (error) {
        handleDocumentProcessingFailure({ error, job });
        throw error;
      }
    },
    {
      connection: createBullMqConnection(),
      concurrency: WORKER_CONCURRENCY,
      lockDuration: 35 * 60 * 1000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
  let readiness: ReturnType<typeof startDocumentOcrWorkerReadiness> | null =
    null;
  let closing = false;
  detached(
    worker.waitUntilReady().then(() => {
      if (closing) {
        return undefined;
      }
      if (ocrConfigured) {
        readiness = startDocumentOcrWorkerReadiness();
      }
      return undefined;
    }),
    "document-processing.publish-readiness",
  );

  worker.on(
    "error",
    createQueueWorkerErrorLogger("document_processing.worker_error"),
  );

  let reconciling = false;
  const reconcile = () => {
    if (reconciling) {
      return;
    }
    reconciling = true;
    detached(
      reconcileDocumentProcessing({
        onComplete: () => {
          reconciling = false;
        },
      }),
      "document-processing.reconcile",
    );
  };
  reconcile();
  const reconcileInterval = setInterval(reconcile, RECONCILE_INTERVAL_MS);
  reconcileInterval.unref();

  logger.info("document_processing.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    close: async (): Promise<void> => {
      closing = true;
      clearInterval(reconcileInterval);
      readiness?.close();
      await abortDocumentProcessingWorkerBeforeClose({
        abortLifecycle: () => {
          lifecycle.abort();
        },
        closeWorker: async () => {
          await worker.close();
        },
      });
      // Drops the connection memo with the client, so a worker started
      // again in this process connects a fresh one instead of trusting a
      // resolved promise for a client that is gone.
      reconciliationRedis.close();
    },
  };
};
