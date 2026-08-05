import { Result, TaggedError } from "better-result";
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

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
  organizationSettings,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { detached } from "@/api/lib/detached";
import type { DocumentOcrPayload } from "@/api/lib/document-processing-contract";
import {
  DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
  serializeDocumentOcrPayload,
} from "@/api/lib/document-processing-contract";
import {
  DOCUMENT_PROCESSING_QUEUE_NAME,
  enqueueDocumentProcessingRun,
  type DocumentProcessingJobData,
} from "@/api/lib/document-processing-enqueue";
import {
  DocumentOcrProviderError,
  isDocumentOcrProviderConfigured,
  recognizePdfText,
} from "@/api/lib/document-processing-provider";
import { startDocumentOcrWorkerReadiness } from "@/api/lib/document-processing-readiness";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { createFileKey, createOcrSearchablePdfKey } from "@/api/lib/file-key";
import { logger } from "@/api/lib/observability/logger";
import { createOcrSearchablePdf } from "@/api/lib/ocr-searchable-pdf";
import {
  createBullMqConnection,
  createRedisClient,
} from "@/api/lib/redis-client";
import { getS3 } from "@/api/lib/s3";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import {
  executeNativeExtraction,
  requiresDurableNativeExtraction,
} from "@/api/lib/search/process-extraction";
import { getSearchProvider } from "@/api/lib/search/provider";
import { broadcast } from "@/api/lib/sse";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { toSafeId } from "@/api/types";

const OCR_SOURCE_URL_TTL_SECONDS = 35 * 60;
const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_BATCH_SIZE = 100;
const ENQUEUE_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;
const ENQUEUE_FAILURE_RETRY_MS = 30_000;
const QUEUED_OCR_SELECTION = {
  ALL_DUE: "all-due",
  SCHEDULED_RETRIES: "scheduled-retries",
} as const;
const WORKER_LEASE_TIMEOUT_MS = 40 * 60 * 1000;
const WORKER_LEASE_HEARTBEAT_MS = 5 * 60 * 1000;
const WORKER_LEASE_HEARTBEAT_TIMEOUT_MS = 30_000;
const SEARCH_INDEX_REPLAY_CONCURRENCY = 2;
const SEARCH_INDEX_REPLAY_BATCH_SIZE = SEARCH_INDEX_REPLAY_CONCURRENCY * 2;
const SEARCH_INDEX_ATTEMPT_TIMEOUT_MS = 30_000;
const SEARCH_INDEX_REPLAY_STATE_TRANSITION_TIMEOUT_MS = 5000;
const REPAIR_SETTLE_DELAY_MS = 5 * 60 * 1000;
const REPAIR_SCAN_CURSOR_KEY = "document-processing:repair-scan-cursor:v1";
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
const AUTOMATIC_OCR_MAX_ATTEMPTS = 5;
const AUTOMATIC_OCR_RETRY_BASE_DELAY_MS = 30_000;
const AUTOMATIC_OCR_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
const SEARCH_INDEX_FAILURE_CODE = "search_index_failed";
const SEARCHABLE_PDF_FAILURE_CODE = "searchable_pdf_failed";
const RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES = [
  "not_configured",
  "processing_failed",
  "request_failed",
] as const;
const SOURCE_SUPERSEDED_CANCELLATION_CODE = "source_superseded";

type CurrentDocumentSource = {
  content: FieldContent;
  currentVersionId: SafeId<"entityVersion"> | null;
  entityReadOnly: boolean;
  fieldEntityVersionId: SafeId<"entityVersion">;
  versionDeletedAt: Date | null;
};

type OcrProjectionProvenance = {
  sourceEntityVersionId: SafeId<"entityVersion"> | null;
  sourceFieldId: SafeId<"field"> | null;
  sourceFileId: string | null;
  sourceSha256Hex: string | null;
};

type ProjectionSourceField = {
  content: FieldContent;
  entityVersionId: SafeId<"entityVersion">;
  id: SafeId<"field">;
  workspaceId: SafeId<"workspace">;
};

export class DocumentProcessingJobError extends TaggedError(
  "DocumentProcessingJobError",
)<{
  code: string;
  message: string;
  cause?: unknown;
}> {}

export const indexDocumentProjection = async ({
  indexEntity,
  timeoutMs = SEARCH_INDEX_ATTEMPT_TIMEOUT_MS,
}: {
  indexEntity: () => Promise<void>;
  timeoutMs?: number;
}): Promise<void> => {
  const indexed = await Result.tryPromise({
    try: async () =>
      await withTimeout(indexEntity, {
        label: "document processing initial search index",
        timeoutMs,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(indexed)) {
    throw new DocumentProcessingJobError({
      code: SEARCH_INDEX_FAILURE_CODE,
      message: "Document text was stored but search indexing failed",
      cause: indexed.error,
    });
  }
};

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
      const sourceBuffer = await getS3().file(sourceKey).arrayBuffer();
      lifecycleSignal.throwIfAborted();
      const searchablePdf = await createOcrSearchablePdf(sourceBuffer, payload);
      if (Result.isError(searchablePdf)) {
        throw searchablePdf.error;
      }
      lifecycleSignal.throwIfAborted();

      await getS3().write(
        createOcrSearchablePdfKey({
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          runId: run.id,
        }),
        searchablePdf.value,
        { type: PDF_MIME_TYPE },
      );
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

export const isCurrentOcrSource = ({
  run,
  source,
}: {
  run: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
  };
  source: CurrentDocumentSource | null;
}): boolean =>
  source !== null &&
  !source.entityReadOnly &&
  source.versionDeletedAt === null &&
  source.currentVersionId === run.entityVersionId &&
  source.fieldEntityVersionId === run.entityVersionId &&
  source.content.type === "file" &&
  source.content.id === run.sourceFileId &&
  source.content.sha256Hex === run.sourceSha256Hex &&
  source.content.mimeType === PDF_MIME_TYPE &&
  !source.content.encrypted;

export const isCurrentNativeExtractionSource = (
  run: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
  },
  source: CurrentDocumentSource | null,
): source is CurrentDocumentSource & {
  content: Extract<FieldContent, { type: "file" }>;
} =>
  source !== null &&
  !source.entityReadOnly &&
  source.versionDeletedAt === null &&
  source.currentVersionId === run.entityVersionId &&
  source.fieldEntityVersionId === run.entityVersionId &&
  source.content.type === "file" &&
  source.content.id === run.sourceFileId &&
  source.content.sha256Hex === run.sourceSha256Hex &&
  requiresDurableNativeExtraction(source.content);

export const isPreservableAutomaticProjection = ({
  currentEntityVersionId,
  currentWorkspaceId,
  provenance,
  sourceField,
}: {
  currentEntityVersionId: SafeId<"entityVersion">;
  currentWorkspaceId: SafeId<"workspace">;
  provenance: OcrProjectionProvenance;
  sourceField: ProjectionSourceField | null;
}): boolean => {
  const isLegacyProjection =
    provenance.sourceEntityVersionId === null &&
    provenance.sourceFieldId === null &&
    provenance.sourceFileId === null &&
    provenance.sourceSha256Hex === null;
  return (
    isLegacyProjection ||
    (provenance.sourceEntityVersionId === currentEntityVersionId &&
      provenance.sourceFieldId !== null &&
      provenance.sourceFileId !== null &&
      provenance.sourceSha256Hex !== null &&
      sourceField !== null &&
      sourceField.id === provenance.sourceFieldId &&
      sourceField.entityVersionId === currentEntityVersionId &&
      sourceField.workspaceId === currentWorkspaceId &&
      sourceField.content.type === "file" &&
      sourceField.content.id === provenance.sourceFileId &&
      sourceField.content.sha256Hex === provenance.sourceSha256Hex)
  );
};

export const shouldPreserveCurrentProjection = (
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"],
): boolean => requestSource !== "manual";

export const shouldFailStaleAutomaticOcrRun = ({
  attemptCount,
  errorCode,
  requestSource,
}: {
  attemptCount: number;
  errorCode: string | null;
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"];
}): boolean =>
  requestSource !== "manual" &&
  errorCode !== SEARCH_INDEX_FAILURE_CODE &&
  attemptCount >= AUTOMATIC_OCR_MAX_ATTEMPTS;

export const classifyOcrProjectionSource = ({
  run,
  source,
  workspaceStatus,
}: {
  run: {
    entityVersionId: SafeId<"entityVersion">;
    fieldId: SafeId<"field">;
    sourceFileId: string;
    sourceSha256Hex: string;
  };
  source: CurrentDocumentSource | null;
  workspaceStatus: (typeof workspaces.$inferSelect)["status"] | undefined;
}): "current" | "source_superseded" | "workspace_unavailable" => {
  if (workspaceStatus !== "active") {
    return "workspace_unavailable";
  }
  return isCurrentOcrSource({ run, source }) ? "current" : "source_superseded";
};

export const classifyOcrWorkspaceDispatch = ({
  requestSource,
  workspaceStatus,
}: {
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"];
  workspaceStatus: (typeof workspaces.$inferSelect)["status"] | undefined;
}): "available" | "deferred" | "workspace_unavailable" => {
  if (workspaceStatus === "active") {
    return "available";
  }
  if (workspaceStatus === "deleting" && requestSource === "manual") {
    return "deferred";
  }
  return "workspace_unavailable";
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
      "document-processing.lease-heartbeat.release",
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
      "document-processing.lease-heartbeat.renew",
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

export const requiresOcrPolicy = (
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"],
): boolean => requestSource !== "manual";

export const ownsPromotedManualOcrClaim = ({
  claimToken,
  run,
}: {
  claimToken: string;
  run:
    | Pick<
        typeof documentProcessingRuns.$inferSelect,
        "claimedBy" | "requestSource" | "status"
      >
    | undefined;
}): boolean =>
  run?.claimedBy === claimToken &&
  run.requestSource === "manual" &&
  run.status === "running";

export const isLifecycleInterruptionError = ({
  error,
  lifecycleSignal,
}: {
  error: unknown;
  lifecycleSignal: AbortSignal;
}): boolean => {
  if (!lifecycleSignal.aborted) {
    return false;
  }

  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !visited.has(current)) {
    if (current === lifecycleSignal.reason) {
      return true;
    }
    visited.add(current);
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      return false;
    }
    current = current.cause;
  }
  return false;
};

export const settleDocumentProcessingAttemptError = async ({
  error,
  lifecycleSignal,
  markFailed,
  returnToQueue,
}: {
  error: unknown;
  lifecycleSignal: AbortSignal;
  markFailed: () => Promise<void>;
  returnToQueue: () => Promise<void>;
}): Promise<"failed" | "interrupted"> => {
  if (isLifecycleInterruptionError({ error, lifecycleSignal })) {
    await returnToQueue();
    return "interrupted";
  }
  await markFailed();
  return "failed";
};

const completeDocumentProcessingRun = async ({
  claimToken,
  run,
}: {
  claimToken: string;
  run: typeof documentProcessingRuns.$inferSelect;
}): Promise<boolean> => {
  const completed = await rootDb
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
        eq(documentProcessingRuns.id, run.id),
        eq(documentProcessingRuns.status, "running"),
        eq(documentProcessingRuns.claimedBy, claimToken),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  if (!completed.at(0)) {
    return false;
  }
  broadcast(run.workspaceId, {
    type: "invalidate-query",
    data: ["entities", run.workspaceId],
  });
  return true;
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
    }

    // Opt-out takes this same settings lock before checking for running
    // automatic jobs. Either it wins and a later worker observes `off` before
    // claiming, or the worker wins and opt-out refuses until this dispatch is
    // terminal; neither path can acknowledge opt-out while it sends a file.
    const settingsRows = await tx
      .select({
        documentProcessingMode: organizationSettings.documentProcessingMode,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, runContext.organizationId))
      .limit(1)
      .for("update");
    if (
      runContext.kind === "ocr" &&
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
        run.kind === "ocr" &&
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
          await executeNativeExtraction({
            fileField: source.content,
            lifecycleSignal,
            run,
          });
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
          await indexDocumentProjection({
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
      const sourceUrl = await presignDownloadUrl(sourceKey, {
        expiresIn: OCR_SOURCE_URL_TTL_SECONDS,
        scope: {
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
        },
      });
      const result = await recognizePdfText({
        idempotencyKey: `ocr:${run.id}`,
        signal: lifecycleSignal,
        sourceUrl,
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

      await indexDocumentProjection({
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
    await settleDocumentProcessingAttemptError({
      error: processingResult.error,
      lifecycleSignal,
      markFailed: async () => {
        await markRunFailed({
          claimToken,
          error: processingResult.error,
          run,
        });
      },
      returnToQueue: async () => {
        await returnInterruptedRunToQueue({ claimToken, run });
      },
    });
    throw processingResult.error;
  }
};

const errorCode = (error: unknown): string => {
  if (
    error instanceof DocumentProcessingJobError ||
    error instanceof DocumentOcrProviderError
  ) {
    return error.code;
  }
  return "processing_failed";
};

export const automaticOcrRetryDelayMs = (attemptCount: number): number =>
  Math.min(
    AUTOMATIC_OCR_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptCount - 1),
    AUTOMATIC_OCR_RETRY_MAX_DELAY_MS,
  );

export const isRetryableAutomaticOcrFailure = ({
  attemptCount,
  errorCode: failureCode,
  requestSource,
}: {
  attemptCount: number;
  errorCode: string;
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"];
}): boolean =>
  requestSource !== "manual" &&
  attemptCount < AUTOMATIC_OCR_MAX_ATTEMPTS &&
  (failureCode === RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES[0] ||
    failureCode === RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES[1] ||
    failureCode === RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES[2]);

export const isRetryableSearchIndexFailure = (failureCode: string): boolean =>
  failureCode === SEARCH_INDEX_FAILURE_CODE;

export const isRetryableOcrDerivativeFailure = ({
  attemptCount,
  errorCode: failureCode,
}: {
  attemptCount: number;
  errorCode: string;
}): boolean =>
  failureCode === SEARCHABLE_PDF_FAILURE_CODE &&
  attemptCount < AUTOMATIC_OCR_MAX_ATTEMPTS;

const markRunFailed = async ({
  claimToken,
  error,
  run,
}: {
  claimToken: string;
  error: unknown;
  run: typeof documentProcessingRuns.$inferSelect;
}): Promise<void> => {
  const failureCode = errorCode(error);
  await rootDb.transaction(async (tx) => {
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
      return;
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
    await tx
      .update(documentProcessingRuns)
      .set({
        claimedAt: null,
        claimedBy: null,
        errorAt: new Date(),
        errorCode: failureCode,
        nextAttemptAt:
          retryable || retryableSearchIndex || retryableDerivative
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
  });
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

let reconciliationRedisClient: ReturnType<typeof createRedisClient> | null =
  null;

const getReconciliationRedis = () => {
  reconciliationRedisClient ??= createRedisClient({
    connectionTimeout: REPAIR_SCAN_CURSOR_COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
  });
  return reconciliationRedisClient;
};

export const readRepairScanCursor = async (
  readCursor: () => Promise<string | null> = async () =>
    await getReconciliationRedis().get(REPAIR_SCAN_CURSOR_KEY),
  timeoutMs = REPAIR_SCAN_CURSOR_COMMAND_TIMEOUT_MS,
): Promise<SafeId<"field"> | null> => {
  const cursor = await withTimeout(readCursor, {
    label: "document OCR repair cursor read",
    timeoutMs,
  });
  return cursor === null ? null : toSafeId<"field">(cursor);
};

export const writeRepairScanCursor = async ({
  expectedCursor,
  nextCursor,
  sendCommand = async (command, args) =>
    Number(await getReconciliationRedis().send(command, args)),
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
): Promise<SafeId<"documentProcessingRun">[]> => {
  if (candidates.length === 0) {
    return [];
  }

  return await rootDb.transaction(async (tx) => {
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

    const repairableConflict = and(
      eq(documentProcessingRuns.status, "cancelled"),
      inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
      inArray(documentProcessingRuns.errorCode, [
        SOURCE_SUPERSEDED_CANCELLATION_CODE,
        "workspace_unavailable",
      ]),
    );
    if (!repairableConflict) {
      return [];
    }
    const queuedAt = new Date();
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

const recoverMissingNativeExtractionRuns = async (): Promise<number> => {
  const settledBefore = new Date(Date.now() - REPAIR_SETTLE_DELAY_MS);
  const cursor = await readRepairScanCursor();
  const candidates = await rootDb
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
          rootDb
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
      await writeRepairScanCursor({ expectedCursor: cursor, nextCursor: null });
    }
    return 0;
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
  const runIds = await persistMissingNativeExtractionRuns(repairCandidates);
  await writeRepairScanCursor({
    expectedCursor: cursor,
    nextCursor:
      candidates.length < RECONCILE_BATCH_SIZE
        ? null
        : (candidates.at(-1)?.fieldId ?? null),
  });
  return runIds.length;
};

const updateQueuedRunSchedule = async ({
  delayMs,
  runIds,
  updatedAt,
}: {
  delayMs: number;
  runIds: SafeId<"documentProcessingRun">[];
  updatedAt: Date;
}): Promise<void> => {
  if (runIds.length === 0) {
    return;
  }
  await rootDb
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
  limit = RECONCILE_BATCH_SIZE,
  selection = QUEUED_OCR_SELECTION.ALL_DUE,
}: {
  limit?: number;
  selection?:
    | typeof QUEUED_OCR_SELECTION.ALL_DUE
    | typeof QUEUED_OCR_SELECTION.SCHEDULED_RETRIES;
} = {}): Promise<{ attempted: number; retryAt: Date | null }> => {
  const now = new Date();
  const runs = await rootDb
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
      async ({ id }) => await tryEnqueueDocumentProcessingRun({ runId: id }),
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
    }
  }

  const updatedAt = new Date();
  await updateQueuedRunSchedule({
    delayMs: ENQUEUE_VISIBILITY_TIMEOUT_MS,
    runIds: enqueuedIds,
    updatedAt,
  });
  await updateQueuedRunSchedule({
    delayMs: ENQUEUE_FAILURE_RETRY_MS,
    runIds: failedIds,
    updatedAt,
  });
  return {
    attempted: runs.length,
    retryAt:
      failedIds.length === 0
        ? null
        : new Date(updatedAt.getTime() + ENQUEUE_FAILURE_RETRY_MS),
  };
};

const dispatchScheduledDocumentProcessingRetries = async (): Promise<number> =>
  (
    await dispatchQueuedDocumentProcessingRuns({
      selection: QUEUED_OCR_SELECTION.SCHEDULED_RETRIES,
    })
  ).attempted;

// Manual searchable-PDF failures are retryable too, so the condition spans
// both automatic OCR sources and every derivative failure.
const retryableOcrFailureCondition = () =>
  or(
    and(
      inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
      inArray(
        documentProcessingRuns.errorCode,
        RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES,
      ),
    ),
    eq(documentProcessingRuns.errorCode, SEARCHABLE_PDF_FAILURE_CODE),
  );

const recoverRetryableOcrFailures = async (): Promise<number> => {
  const now = new Date();
  const retryableRuns = await rootDb
    .select({
      attemptCount: documentProcessingRuns.attemptCount,
      id: documentProcessingRuns.id,
      nextAttemptAt: documentProcessingRuns.nextAttemptAt,
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
  if (retryableRuns.length === 0) {
    return 0;
  }

  const capturedSchedules = or(
    ...retryableRuns.map(({ attemptCount, id, nextAttemptAt }) =>
      and(
        eq(documentProcessingRuns.id, id),
        eq(documentProcessingRuns.attemptCount, attemptCount),
        nextAttemptAt === null
          ? isNull(documentProcessingRuns.nextAttemptAt)
          : eq(documentProcessingRuns.nextAttemptAt, nextAttemptAt),
      ),
    ),
  );
  if (!capturedSchedules) {
    return 0;
  }

  const recovered = await rootDb
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
  return recovered.length;
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

export const mapWithConcurrency = async <Item, Value>({
  items,
  limit,
  operation,
}: {
  items: Item[];
  limit: number;
  operation: (item: Item) => Promise<Value>;
}): Promise<Value[]> => {
  const values: Value[] = [];
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    const item = items.at(index);
    if (item === undefined) {
      return;
    }
    values[index] = await operation(item);
    await run();
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, run),
  );
  return values;
};

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

const recoverFailedSearchIndex = async ({
  attemptCount,
  claimToken,
  entityId,
  id,
  workspaceId,
}: FailedSearchIndexCandidate): Promise<boolean> =>
  await runSearchIndexReplayAttempt({
    indexEntity: async () => await getSearchProvider().indexEntity(entityId),
    onFailure: async (error) => {
      captureError(error, { entityId, runId: id });
      await rootDb
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
      const completed = await rootDb
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

      broadcast(workspaceId, {
        type: "invalidate-query",
        data: ["entities", workspaceId],
      });
      return true;
    },
  });

const recoverFailedOcrSearchIndexes = async (): Promise<number> => {
  const now = new Date();
  // The failed run is the durable retry token, but the entity projection is
  // the indexing source of truth. Automatic OCR may have preserved valid text
  // from another current field, so replay validates that projection's own
  // provenance instead of requiring it to match the failed run's source.
  const candidates = await rootDb
    .select({
      attemptCount: documentProcessingRuns.attemptCount,
      entityId: documentProcessingRuns.entityId,
      id: documentProcessingRuns.id,
      nextAttemptAt: documentProcessingRuns.nextAttemptAt,
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

  if (candidates.length === 0) {
    return 0;
  }
  const capturedSchedules = or(
    ...candidates.map(({ attemptCount, id, nextAttemptAt }) =>
      and(
        eq(documentProcessingRuns.id, id),
        eq(documentProcessingRuns.attemptCount, attemptCount),
        nextAttemptAt === null
          ? isNull(documentProcessingRuns.nextAttemptAt)
          : eq(documentProcessingRuns.nextAttemptAt, nextAttemptAt),
      ),
    ),
  );
  if (!capturedSchedules) {
    return 0;
  }

  const claimToken = `search-index-replay:${Bun.randomUUIDv7()}`;
  const claimed = await rootDb
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
    operation: recoverFailedSearchIndex,
  });
  return recovered.filter(Boolean).length;
};

const recoverStaleDocumentProcessingRuns = async (): Promise<number> => {
  const staleBefore = new Date(Date.now() - WORKER_LEASE_TIMEOUT_MS);
  const recoveredAt = new Date();
  const staleRuns = await rootDb
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
  if (staleRuns.length === 0) {
    return 0;
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
      : await rootDb
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
      : await rootDb
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
  const recovered = await rootDb
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
  return exhausted.length + searchReplays.length + recovered.length;
};

const handleDocumentProcessingFailure = ({
  error,
  job,
}: {
  error: unknown;
  job: { data: DocumentProcessingJobData } | undefined;
}): void => {
  captureError(error, { runId: job?.data.runId ?? "" });
  logger.error("document_processing.failed", {
    "error.type": errorTag(error),
    runId: job?.data.runId ?? "",
  });
};

const RECONCILIATION_PHASE = {
  DELIVERY: "delivery",
  REINDEX: "reindex",
  REPAIR: "repair",
  RETRY: "retry",
  STALE_LEASE: "stale-lease",
} as const;

type ReconciliationPhaseName =
  (typeof RECONCILIATION_PHASE)[keyof typeof RECONCILIATION_PHASE];

type ReconciliationCounts = Record<ReconciliationPhaseName, number>;

type ReconciliationPhase = {
  name: ReconciliationPhaseName;
  run: () => Promise<number>;
};

export const runDocumentProcessingReconciliationPhases = async ({
  onPhaseError,
  phases,
}: {
  onPhaseError: (error: unknown, phase: ReconciliationPhaseName) => void;
  phases: readonly ReconciliationPhase[];
}): Promise<ReconciliationCounts> => {
  const counts: ReconciliationCounts = {
    [RECONCILIATION_PHASE.DELIVERY]: 0,
    [RECONCILIATION_PHASE.REINDEX]: 0,
    [RECONCILIATION_PHASE.REPAIR]: 0,
    [RECONCILIATION_PHASE.RETRY]: 0,
    [RECONCILIATION_PHASE.STALE_LEASE]: 0,
  };
  for (const phase of phases) {
    // oxlint-disable-next-line no-await-in-loop -- repair phases are deliberately isolated and ordered
    const result = await Result.tryPromise({
      try: phase.run,
      catch: (cause) => cause,
    });
    if (Result.isError(result)) {
      onPhaseError(result.error, phase.name);
      continue;
    }
    counts[phase.name] = result.value;
  }
  return counts;
};

const reconcileDocumentProcessing = async ({
  onComplete,
}: {
  onComplete: () => void;
}): Promise<void> => {
  try {
    const counts = await runDocumentProcessingReconciliationPhases({
      phases: [
        {
          name: RECONCILIATION_PHASE.REPAIR,
          run: recoverMissingNativeExtractionRuns,
        },
        {
          name: RECONCILIATION_PHASE.REINDEX,
          run: recoverFailedOcrSearchIndexes,
        },
        {
          name: RECONCILIATION_PHASE.RETRY,
          run: recoverRetryableOcrFailures,
        },
        {
          name: RECONCILIATION_PHASE.STALE_LEASE,
          run: recoverStaleDocumentProcessingRuns,
        },
        {
          name: RECONCILIATION_PHASE.DELIVERY,
          run: dispatchScheduledDocumentProcessingRetries,
        },
      ],
      onPhaseError: (error, phase) => {
        captureError(error, { phase });
        logger.error("document_processing.reconcile_phase_failed", {
          "error.type": errorTag(error),
          phase,
        });
      },
    });
    if (
      counts[RECONCILIATION_PHASE.DELIVERY] > 0 ||
      counts[RECONCILIATION_PHASE.REPAIR] > 0 ||
      counts[RECONCILIATION_PHASE.REINDEX] > 0 ||
      counts[RECONCILIATION_PHASE.RETRY] > 0 ||
      counts[RECONCILIATION_PHASE.STALE_LEASE] > 0
    ) {
      logger.info("document_processing.reconciled", {
        deliveredCount: String(counts[RECONCILIATION_PHASE.DELIVERY]),
        recoveredCount: String(counts[RECONCILIATION_PHASE.STALE_LEASE]),
        reindexedCount: String(counts[RECONCILIATION_PHASE.REINDEX]),
        repairedCount: String(counts[RECONCILIATION_PHASE.REPAIR]),
        retriedCount: String(counts[RECONCILIATION_PHASE.RETRY]),
      });
    }
  } catch (error) {
    captureError(error);
    logger.error("document_processing.reconcile_failed", {
      "error.type": errorTag(error),
    });
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
  const ocrProviderConfigured = isDocumentOcrProviderConfigured();

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
      if (ocrProviderConfigured) {
        readiness = startDocumentOcrWorkerReadiness();
      }
      return undefined;
    }),
    "document-processing.publish-readiness",
  );

  worker.on("error", (error) => {
    logger.error(
      "document_processing.worker_error",
      connectionErrorFields(error),
    );
  });

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
      reconciliationRedisClient?.close();
      reconciliationRedisClient = null;
    },
  };
};
