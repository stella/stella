import { Result, TaggedError } from "better-result";
import { Worker } from "bullmq";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
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
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { detached } from "@/api/lib/detached";
import {
  DOCUMENT_PROCESSING_QUEUE_NAME,
  enqueueDocumentProcessingRun,
  type DocumentProcessingJobData,
} from "@/api/lib/document-processing-enqueue";
import {
  DocumentOcrProviderError,
  recognizePdfText,
} from "@/api/lib/document-processing-provider";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { createFileKey } from "@/api/lib/file-key";
import { logger } from "@/api/lib/observability/logger";
import {
  createBullMqConnection,
  createRedisClient,
} from "@/api/lib/redis-client";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import { getSearchProvider } from "@/api/lib/search/provider";
import { broadcast } from "@/api/lib/sse";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const OCR_SOURCE_URL_TTL_SECONDS = 35 * 60;
const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 30_000;
const RECONCILE_BATCH_SIZE = 100;
const ENQUEUE_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;
const ENQUEUE_FAILURE_RETRY_MS = 30_000;
const WORKER_LEASE_TIMEOUT_MS = 40 * 60 * 1000;
const WORKER_LEASE_HEARTBEAT_MS = 5 * 60 * 1000;
const REPAIR_SETTLE_DELAY_MS = 5 * 60 * 1000;
const REPAIR_SCAN_CURSOR_KEY = "document-processing:repair-scan-cursor:v1";
const AUTOMATIC_OCR_MAX_ATTEMPTS = 5;
const AUTOMATIC_OCR_RETRY_BASE_DELAY_MS = 30_000;
const AUTOMATIC_OCR_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
const SEARCH_INDEX_FAILURE_CODE = "search_index_failed";
const RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES = [
  "not_configured",
  "processing_failed",
  "request_failed",
] as const;
const REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES = [
  "policy_disabled",
  "workspace_unavailable",
] as const;

type CurrentOcrSource = {
  content: FieldContent;
  currentVersionId: SafeId<"entityVersion"> | null;
  entityReadOnly: boolean;
  fieldEntityVersionId: SafeId<"entityVersion">;
  versionDeletedAt: Date | null;
};

export class DocumentProcessingJobError extends TaggedError(
  "DocumentProcessingJobError",
)<{
  code: string;
  message: string;
  cause?: unknown;
}>() {}

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
  source: CurrentOcrSource | null;
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
  source: CurrentOcrSource | null;
  workspaceStatus: (typeof workspaces.$inferSelect)["status"] | undefined;
}): "current" | "source_superseded" | "workspace_unavailable" => {
  if (workspaceStatus !== "active") {
    return "workspace_unavailable";
  }
  return isCurrentOcrSource({ run, source }) ? "current" : "source_superseded";
};

export const isAutomaticOcrRepairCandidate = (
  content: FieldContent,
): content is Extract<FieldContent, { type: "file" }> =>
  content.type === "file" &&
  content.mimeType === PDF_MIME_TYPE &&
  !content.encrypted;

export const isReversibleAutomaticOcrCancellation = ({
  errorCode,
  status,
}: {
  errorCode: string | null;
  status: (typeof documentProcessingRuns.$inferSelect)["status"];
}): boolean => {
  if (status !== "cancelled") {
    return false;
  }
  return (
    errorCode === REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES[0] ||
    errorCode === REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES[1]
  );
};

const markRunCancelled = async (
  runId: SafeId<"documentProcessingRun">,
  claimToken: string,
  cancellationCode:
    | "policy_disabled"
    | "source_superseded"
    | "workspace_unavailable",
): Promise<void> => {
  await rootDb
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
      ),
    );
};

type DocumentProcessingLeaseHeartbeat = {
  stop: () => void;
};

const startDocumentProcessingLeaseHeartbeat = ({
  claimToken,
  runId,
}: {
  claimToken: string;
  runId: SafeId<"documentProcessingRun">;
}): DocumentProcessingLeaseHeartbeat => {
  const renew = async () => {
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
  };

  const timer = setInterval(() => {
    detached(
      renew().catch((error: unknown) => {
        logger.warn("document_processing.lease_heartbeat_failed", {
          "error.type": errorTag(error),
          runId,
        });
      }),
      "startDocumentProcessingLeaseHeartbeat",
    );
  }, WORKER_LEASE_HEARTBEAT_MS);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
};

const readCurrentOcrSource = async ({
  entityId,
  fieldId,
  organizationId,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
}): Promise<CurrentOcrSource | null> => {
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

const persistOcrProjection = async ({
  claimToken,
  ciphertext,
  iv,
  pageCount,
  run,
  textLength,
}: {
  claimToken: string;
  ciphertext: Buffer;
  iv: Buffer;
  pageCount: number;
  run: typeof documentProcessingRuns.$inferSelect;
  textLength: number;
}): Promise<boolean> =>
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
      .returning({ id: documentProcessingRuns.id });
    if (!ownedClaims.at(0)) {
      return false;
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
      return false;
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
    return true;
  });

export const requiresOcrPolicy = (
  requestSource: (typeof documentProcessingRuns.$inferSelect)["requestSource"],
): boolean => requestSource !== "manual";

export const processDocumentProcessingRun = async (
  runId: SafeId<"documentProcessingRun">,
): Promise<void> => {
  const claimToken = Bun.randomUUIDv7();
  const run = await rootDb.transaction(async (tx) => {
    const runRows = await tx
      .select({
        entityId: documentProcessingRuns.entityId,
        entityVersionId: documentProcessingRuns.entityVersionId,
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
    if (workspace?.status !== "active") {
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
      const settings = await rootDb.query.organizationSettings.findFirst({
        where: { organizationId: { eq: run.organizationId } },
        columns: { documentProcessingMode: true },
      });
      if (
        requiresOcrPolicy(run.requestSource) &&
        settings?.documentProcessingMode !== "searchable-text"
      ) {
        await markRunCancelled(run.id, claimToken, "policy_disabled");
        return;
      }

      const source = await readCurrentOcrSource({
        entityId: run.entityId,
        fieldId: run.fieldId,
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
      });
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
        sourceUrl,
      });
      if (Result.isError(result)) {
        throw new DocumentProcessingJobError({
          code: result.error.code,
          message: result.error.message,
          cause: result.error,
        });
      }

      const encrypted = await encryptContent(
        run.organizationId,
        result.value.text,
      );
      const persisted = await persistOcrProjection({
        claimToken,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        pageCount: result.value.pageCount,
        run,
        textLength: result.value.text.length,
      });
      if (!persisted) {
        return;
      }

      const indexResult = await Result.tryPromise({
        try: async () => await getSearchProvider().indexEntity(run.entityId),
        catch: (cause) => cause,
      });
      if (Result.isError(indexResult)) {
        throw new DocumentProcessingJobError({
          code: SEARCH_INDEX_FAILURE_CODE,
          message: "OCR text was stored but search indexing failed",
          cause: indexResult.error,
        });
      }
      const completed = await rootDb
        .update(documentProcessingRuns)
        .set({
          claimedAt: null,
          claimedBy: null,
          errorAt: null,
          errorCode: null,
          finishedAt: new Date(),
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
        return;
      }

      broadcast(run.workspaceId, {
        type: "invalidate-query",
        data: ["entities", run.workspaceId],
      });
    },
    catch: (cause) => cause,
  });
  heartbeat.stop();

  if (Result.isError(processingResult)) {
    await markRunFailed({
      claimToken,
      error: processingResult.error,
      run,
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
  const retryable = isRetryableAutomaticOcrFailure({
    attemptCount: run.attemptCount,
    errorCode: failureCode,
    requestSource: run.requestSource,
  });
  const retryableSearchIndex = isRetryableSearchIndexFailure(failureCode);
  await rootDb
    .update(documentProcessingRuns)
    .set({
      claimedAt: null,
      claimedBy: null,
      errorAt: new Date(),
      errorCode: failureCode,
      nextAttemptAt:
        retryable || retryableSearchIndex
          ? new Date(Date.now() + automaticOcrRetryDelayMs(run.attemptCount))
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
};

const earlierFileFields = alias(
  fields,
  "document_processing_earlier_file_fields",
);

type AutomaticOcrCandidate = {
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
  reconciliationRedisClient ??= createRedisClient();
  return reconciliationRedisClient;
};

const readRepairScanCursor = async (): Promise<SafeId<"field"> | null> => {
  const cursor = await getReconciliationRedis().get(REPAIR_SCAN_CURSOR_KEY);
  return cursor === null ? null : toSafeId<"field">(cursor);
};

const writeRepairScanCursor = async (
  cursor: SafeId<"field"> | null,
): Promise<void> => {
  if (cursor === null) {
    await getReconciliationRedis().del(REPAIR_SCAN_CURSOR_KEY);
    return;
  }
  await getReconciliationRedis().set(REPAIR_SCAN_CURSOR_KEY, cursor);
};

const isSameAutomaticOcrSource = (
  candidate: AutomaticOcrCandidate,
  field: {
    content: FieldContent;
    entityVersionId: SafeId<"entityVersion">;
    id: SafeId<"field">;
    workspaceId: SafeId<"workspace">;
  },
): boolean =>
  isAutomaticOcrRepairCandidate(field.content) &&
  field.id === candidate.fieldId &&
  field.workspaceId === candidate.workspaceId &&
  field.entityVersionId === candidate.entityVersionId &&
  field.content.id === candidate.content.id &&
  field.content.sha256Hex === candidate.content.sha256Hex;

const persistRepairableOcrRuns = async (
  candidates: AutomaticOcrCandidate[],
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
            candidates.map(({ workspaceId }) => workspaceId),
          ),
        ),
      )
      .orderBy(asc(entities.id))
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
            candidates.map(({ workspaceId }) => workspaceId),
          ),
        ),
      );
    const currentFieldById = new Map(
      currentFields.map((field) => [field.id, field]),
    );
    const currentCandidates = candidates.filter((candidate) => {
      const entity = lockedEntityById.get(candidate.entityId);
      const field = currentFieldById.get(candidate.fieldId);
      return (
        entity?.currentVersionId === candidate.entityVersionId &&
        entity.workspaceId === candidate.workspaceId &&
        !entity.readOnly &&
        field !== undefined &&
        isSameAutomaticOcrSource(candidate, field)
      );
    });
    if (currentCandidates.length === 0) {
      return [];
    }

    const projectionScope = or(
      ...currentCandidates.map((candidate) =>
        and(
          eq(extractedContent.organizationId, candidate.organizationId),
          eq(extractedContent.workspaceId, candidate.workspaceId),
          eq(extractedContent.entityId, candidate.entityId),
          eq(extractedContent.sourceEntityVersionId, candidate.entityVersionId),
          eq(extractedContent.sourceFieldId, candidate.fieldId),
          eq(extractedContent.sourceFileId, candidate.content.id),
          eq(extractedContent.sourceSha256Hex, candidate.content.sha256Hex),
        ),
      ),
    );
    const projectedRows = projectionScope
      ? await tx
          .select({ entityId: extractedContent.entityId })
          .from(extractedContent)
          .where(projectionScope)
      : [];
    const projectedEntityIds = new Set(
      projectedRows.map(({ entityId }) => entityId),
    );
    const values = currentCandidates
      .filter(({ entityId }) => !projectedEntityIds.has(entityId))
      .map(
        (candidate) =>
          ({
            id: createSafeId<"documentProcessingRun">(),
            entityId: candidate.entityId,
            entityVersionId: candidate.entityVersionId,
            fieldId: candidate.fieldId,
            kind: "ocr",
            organizationId: candidate.organizationId,
            processorVersion: 1,
            requestedBy: null,
            requestSource: "repair",
            sourceFileId: candidate.content.id,
            sourceSha256Hex: candidate.content.sha256Hex,
            workspaceId: candidate.workspaceId,
          }) satisfies typeof documentProcessingRuns.$inferInsert,
      );
    if (values.length === 0) {
      return [];
    }

    const repairableConflict = or(
      eq(documentProcessingRuns.status, "succeeded"),
      and(
        inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
        eq(documentProcessingRuns.status, "cancelled"),
        inArray(
          documentProcessingRuns.errorCode,
          REVERSIBLE_AUTOMATIC_OCR_CANCELLATION_CODES,
        ),
      ),
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
          errorAt: null,
          errorCode: null,
          finishedAt: null,
          nextAttemptAt: null,
          requestedBy: null,
          requestSource: "repair",
          status: "queued",
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

const tryEnqueueDocumentProcessingRun = async (
  runId: SafeId<"documentProcessingRun">,
): Promise<EnqueueAttemptResult> => {
  const result = await Result.tryPromise({
    try: async () => {
      await enqueueDocumentProcessingRun(runId);
      return undefined;
    },
    catch: (cause) => cause,
  });
  if (Result.isError(result)) {
    captureError(result.error, { runId });
    return { runId, status: "failed" };
  }
  return { runId, status: "enqueued" };
};

const recoverMissingAutomaticOcrRuns = async (): Promise<number> => {
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
    .innerJoin(
      organizationSettings,
      and(
        eq(organizationSettings.organizationId, workspaces.organizationId),
        eq(organizationSettings.documentProcessingMode, "searchable-text"),
      ),
    )
    .where(
      and(
        cursor === null ? undefined : gt(fields.id, cursor),
        lt(entityVersions.createdAt, settledBefore),
        eq(workspaces.status, "active"),
        sql`${fields.content}->>'type' = 'file'
          AND ${fields.content}->>'mimeType' = 'application/pdf'
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
      await writeRepairScanCursor(null);
    }
    return 0;
  }

  const repairCandidates = candidates.flatMap((candidate) => {
    if (!isAutomaticOcrRepairCandidate(candidate.content)) {
      return [];
    }
    return [{ ...candidate, content: candidate.content }];
  });
  const runIds = await persistRepairableOcrRuns(repairCandidates);
  await Promise.all(runIds.map(tryEnqueueDocumentProcessingRun));
  await writeRepairScanCursor(
    candidates.length < RECONCILE_BATCH_SIZE
      ? null
      : (candidates.at(-1)?.fieldId ?? null),
  );
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

const enqueueQueuedRuns = async (): Promise<number> => {
  const now = new Date();
  const runs = await rootDb
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.status, "queued"),
        or(
          isNull(documentProcessingRuns.nextAttemptAt),
          lte(documentProcessingRuns.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(
      asc(documentProcessingRuns.createdAt),
      asc(documentProcessingRuns.id),
    )
    .limit(RECONCILE_BATCH_SIZE);

  const attempts = await Promise.all(
    runs.map(async ({ id }) => await tryEnqueueDocumentProcessingRun(id)),
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
  return runs.length;
};

const recoverRetryableAutomaticOcrFailures = async (): Promise<number> => {
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
        inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
        inArray(
          documentProcessingRuns.errorCode,
          RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES,
        ),
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
      nextAttemptAt: null,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.status, "failed"),
        inArray(documentProcessingRuns.requestSource, ["upload", "repair"]),
        inArray(
          documentProcessingRuns.errorCode,
          RETRYABLE_AUTOMATIC_OCR_FAILURE_CODES,
        ),
        capturedSchedules,
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return recovered.length;
};

type FailedSearchIndexCandidate = {
  attemptCount: number;
  entityId: SafeId<"entity">;
  id: SafeId<"documentProcessingRun">;
  workspaceId: SafeId<"workspace">;
};

const recoverFailedSearchIndex = async ({
  attemptCount,
  entityId,
  id,
  workspaceId,
}: FailedSearchIndexCandidate): Promise<boolean> => {
  const indexed = await Result.tryPromise({
    try: async () => await getSearchProvider().indexEntity(entityId),
    catch: (cause) => cause,
  });
  if (Result.isError(indexed)) {
    captureError(indexed.error, { entityId, runId: id });
    await rootDb
      .update(documentProcessingRuns)
      .set({
        attemptCount: sql`${documentProcessingRuns.attemptCount} + 1`,
        errorAt: new Date(),
        nextAttemptAt: new Date(
          Date.now() + automaticOcrRetryDelayMs(attemptCount + 1),
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingRuns.id, id),
          eq(documentProcessingRuns.status, "failed"),
          eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
          eq(documentProcessingRuns.attemptCount, attemptCount),
        ),
      );
    return false;
  }

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
        eq(documentProcessingRuns.status, "failed"),
        eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
        eq(documentProcessingRuns.attemptCount, attemptCount),
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
};

const recoverFailedOcrSearchIndexes = async (): Promise<number> => {
  const now = new Date();
  const candidates = await rootDb
    .select({
      attemptCount: documentProcessingRuns.attemptCount,
      entityId: documentProcessingRuns.entityId,
      id: documentProcessingRuns.id,
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
        eq(
          extractedContent.sourceEntityVersionId,
          documentProcessingRuns.entityVersionId,
        ),
        eq(extractedContent.sourceFieldId, documentProcessingRuns.fieldId),
        eq(extractedContent.sourceFileId, documentProcessingRuns.sourceFileId),
        eq(
          extractedContent.sourceSha256Hex,
          documentProcessingRuns.sourceSha256Hex,
        ),
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
    .innerJoin(
      fields,
      and(
        eq(fields.id, documentProcessingRuns.fieldId),
        eq(fields.workspaceId, documentProcessingRuns.workspaceId),
        eq(fields.entityVersionId, documentProcessingRuns.entityVersionId),
        sql`${fields.content}->>'type' = 'file'
          AND ${fields.content}->>'id' = ${documentProcessingRuns.sourceFileId}::text
          AND ${fields.content}->>'sha256Hex' = ${documentProcessingRuns.sourceSha256Hex}`,
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

  const recovered = await Promise.all(candidates.map(recoverFailedSearchIndex));
  return recovered.filter(Boolean).length;
};

const recoverStaleDocumentProcessingRuns = async (): Promise<number> => {
  const staleBefore = new Date(Date.now() - WORKER_LEASE_TIMEOUT_MS);
  const staleRuns = await rootDb
    .select({ id: documentProcessingRuns.id })
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

  const ids = staleRuns.map(({ id }) => id);
  const recovered = await rootDb
    .update(documentProcessingRuns)
    .set({
      claimedAt: null,
      claimedBy: null,
      errorAt: new Date(),
      errorCode: "worker_lease_expired",
      nextAttemptAt: null,
      status: "queued",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(documentProcessingRuns.id, ids),
        eq(documentProcessingRuns.status, "running"),
        lt(documentProcessingRuns.claimedAt, staleBefore),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return recovered.length;
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

const reconcileDocumentProcessing = async ({
  onComplete,
}: {
  onComplete: () => void;
}): Promise<void> => {
  try {
    const repairedCount = await recoverMissingAutomaticOcrRuns();
    const reindexedCount = await recoverFailedOcrSearchIndexes();
    const retriedCount = await recoverRetryableAutomaticOcrFailures();
    const recoveredCount = await recoverStaleDocumentProcessingRuns();
    const enqueuedCount = await enqueueQueuedRuns();
    if (
      repairedCount > 0 ||
      reindexedCount > 0 ||
      retriedCount > 0 ||
      recoveredCount > 0 ||
      enqueuedCount > 0
    ) {
      logger.info("document_processing.reconciled", {
        enqueuedCount: String(enqueuedCount),
        recoveredCount: String(recoveredCount),
        reindexedCount: String(reindexedCount),
        repairedCount: String(repairedCount),
        retriedCount: String(retriedCount),
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

export const initDocumentProcessingWorker = () => {
  const worker = new Worker<DocumentProcessingJobData>(
    DOCUMENT_PROCESSING_QUEUE_NAME,
    async (job) => {
      try {
        await processDocumentProcessingRun(job.data.runId);
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
      clearInterval(reconcileInterval);
      await worker.close();
      reconciliationRedisClient?.close();
      reconciliationRedisClient = null;
    },
  };
};
