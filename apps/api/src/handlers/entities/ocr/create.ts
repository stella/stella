import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { isDocumentOcrWorkerAvailable } from "@/api/lib/document-processing-readiness";
import {
  persistManualOcrRun,
  type ManualOcrSource,
  type PersistedDocumentProcessingRun,
} from "@/api/lib/document-processing-request";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const createOcrParams = workspaceParams({
  entityId: tSafeId("entity"),
});

const createOcrBody = t.Object({
  fieldId: tSafeId("field"),
});

const config = {
  description:
    "Queue searchable-text recognition for an unencrypted PDF field on a " +
    "document. Returns the durable run and reports when that source was " +
    "already processed.",
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "document_processing" },
  access: "write",
  body: createOcrBody,
  params: createOcrParams,
} satisfies HandlerConfig;

type FindManualOcrSourceResult = Result<
  ManualOcrSource,
  HandlerError<400 | 404 | 409> | SafeDbError
>;

type ManualOcrResponse = {
  outcome: "already_processed" | "queued";
  runId: SafeId<"documentProcessingRun">;
};

type RequestManualOcrProps = {
  captureEnqueueError?: typeof captureError;
  enqueue?: (runId: PersistedDocumentProcessingRun["id"]) => Promise<void>;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  persistRun?: typeof persistManualOcrRun;
  workerAvailable?: () => Promise<boolean>;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const getManualOcrOutcome = ({ status }: PersistedDocumentProcessingRun) =>
  status === "succeeded" ? "already_processed" : "queued";

const findManualOcrSource = async ({
  entityId,
  fieldId,
  safeDb,
  workspaceId,
}: Pick<
  RequestManualOcrProps,
  "entityId" | "fieldId" | "safeDb" | "workspaceId"
>): Promise<FindManualOcrSourceResult> => {
  const rows = await safeDb((tx) =>
    tx
      .select({
        content: fields.content,
        entityId: entities.id,
        entityVersionId: entityVersions.id,
        fieldId: fields.id,
        readOnly: entities.readOnly,
        versionDeletedAt: entityVersions.deletedAt,
      })
      .from(entities)
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, entities.currentVersionId),
          eq(entityVersions.entityId, entities.id),
          eq(entityVersions.workspaceId, workspaceId),
        ),
      )
      .innerJoin(
        fields,
        and(
          eq(fields.id, fieldId),
          eq(fields.entityVersionId, entityVersions.id),
          eq(fields.workspaceId, workspaceId),
        ),
      )
      .where(
        and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId)),
      )
      .limit(1),
  );
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }

  const row = rows.value.at(0);
  if (!row || row.versionDeletedAt !== null) {
    return Result.err(
      new HandlerError({ status: 404, message: "Document file not found" }),
    );
  }
  if (row.readOnly) {
    return Result.err(
      new HandlerError({ status: 409, message: "Entity is read-only" }),
    );
  }
  if (row.content.type !== "file") {
    return Result.err(
      new HandlerError({ status: 400, message: "Field is not a file" }),
    );
  }
  if (row.content.mimeType !== PDF_MIME_TYPE) {
    return Result.err(
      new HandlerError({ status: 400, message: "File must be a PDF" }),
    );
  }
  if (row.content.encrypted) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Encrypted PDFs cannot be processed",
      }),
    );
  }

  return Result.ok({
    entityId: row.entityId,
    entityVersionId: row.entityVersionId,
    fieldId: row.fieldId,
    sourceFileId: row.content.id,
    sourceSha256Hex: row.content.sha256Hex,
  } satisfies ManualOcrSource);
};

export const requestManualOcrHandler = async function* ({
  captureEnqueueError = captureError,
  enqueue = enqueueDocumentProcessingRun,
  entityId,
  fieldId,
  organizationId,
  persistRun = persistManualOcrRun,
  workerAvailable = isDocumentOcrWorkerAvailable,
  recordAuditEvent,
  safeDb,
  userId,
  workspaceId,
}: RequestManualOcrProps): SafeHandlerGenerator<ManualOcrResponse> {
  if (!(await workerAvailable())) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "Document processing is not configured",
      }),
    );
  }

  const source = yield* Result.await(
    findManualOcrSource({ entityId, fieldId, safeDb, workspaceId }),
  );
  const run = yield* Result.await(
    Result.tryPromise({
      try: async () =>
        await persistRun({
          organizationId,
          recordAuditEvent,
          source,
          userId,
          workspaceId,
        }),
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Could not queue document processing",
          cause,
        }),
    }),
  );
  if (!run) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Document version changed; retry the request",
      }),
    );
  }

  if (run.status === "queued") {
    const enqueueResult = await Result.tryPromise({
      try: async () => await enqueue(run.id),
      catch: (cause) => cause,
    });
    if (Result.isError(enqueueResult)) {
      // The durable queued run is reconciled even when this immediate delivery
      // attempt fails. Keep the failure observable without retracting the ack.
      captureEnqueueError(enqueueResult.error, { runId: run.id });
    }
  }

  return Result.ok({ outcome: getManualOcrOutcome(run), runId: run.id });
};

const requestOcr = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    params,
    body,
    user,
    recordAuditEvent,
  }) {
    return yield* requestManualOcrHandler({
      entityId: params.entityId,
      fieldId: body.fieldId,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      safeDb,
      userId: user.id,
      workspaceId,
    });
  },
);

export default requestOcr;
