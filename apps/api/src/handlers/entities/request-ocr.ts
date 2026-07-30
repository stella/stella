import { Result } from "better-result";
import { and, eq, or } from "drizzle-orm";
import { t } from "elysia";

import { rootDb } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  workspaces,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-queue";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const OCR_PROCESSOR_VERSION = 1;

const requestOcrParams = workspaceParams({
  entityId: tSafeId("entity"),
});

const requestOcrBody = t.Object({
  fieldId: tSafeId("field"),
});

const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "document_processing" },
  access: "write",
  body: requestOcrBody,
  params: requestOcrParams,
} satisfies HandlerConfig;

type OcrSource = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  sourceFileId: string;
  sourceSha256Hex: string;
};

type FindManualOcrSourceResult = Result<
  OcrSource,
  HandlerError<400 | 404 | 409> | SafeDbError
>;

type PersistedRun = {
  id: (typeof documentProcessingRuns.$inferSelect)["id"];
  status: (typeof documentProcessingRuns.$inferSelect)["status"];
};

type PersistManualOcrRun = (input: {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  source: OcrSource;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
}) => Promise<PersistedRun | null>;

type RequestManualOcrProps = {
  enqueue?: (runId: PersistedRun["id"]) => Promise<void>;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  persistRun?: PersistManualOcrRun;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

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
  } satisfies OcrSource);
};

const persistManualOcrRun: PersistManualOcrRun = async ({
  organizationId,
  recordAuditEvent,
  source,
  userId,
  workspaceId,
}) =>
  await rootDb.transaction(async (tx) => {
    // Re-check and lock the mutable entity under the root write. The scoped
    // validation above authorizes the request; this prevents a concurrent
    // version replacement from queuing OCR for a no-longer-current file.
    const currentRows = await tx
      .select({ id: entities.id })
      .from(entities)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, entities.workspaceId),
          eq(workspaces.organizationId, organizationId),
        ),
      )
      .where(
        and(
          eq(entities.id, source.entityId),
          eq(entities.workspaceId, workspaceId),
          eq(entities.currentVersionId, source.entityVersionId),
          eq(entities.readOnly, false),
        ),
      )
      .limit(1)
      .for("update");
    if (!currentRows.at(0)) {
      return null;
    }

    const inserted = await tx
      .insert(documentProcessingRuns)
      .values({
        id: createSafeId<"documentProcessingRun">(),
        organizationId,
        workspaceId,
        entityId: source.entityId,
        entityVersionId: source.entityVersionId,
        fieldId: source.fieldId,
        sourceFileId: source.sourceFileId,
        sourceSha256Hex: source.sourceSha256Hex,
        kind: "ocr",
        processorVersion: OCR_PROCESSOR_VERSION,
        requestSource: "manual",
        requestedBy: userId,
      })
      .onConflictDoNothing({
        target: [
          documentProcessingRuns.organizationId,
          documentProcessingRuns.kind,
          documentProcessingRuns.entityVersionId,
          documentProcessingRuns.fieldId,
          documentProcessingRuns.sourceFileId,
          documentProcessingRuns.sourceSha256Hex,
          documentProcessingRuns.processorVersion,
        ],
      })
      .returning({
        id: documentProcessingRuns.id,
        status: documentProcessingRuns.status,
      });
    let run: PersistedRun | null = inserted.at(0) ?? null;
    if (!run) {
      const existing = await tx.query.documentProcessingRuns.findFirst({
        where: {
          organizationId: { eq: organizationId },
          workspaceId: { eq: workspaceId },
          entityId: { eq: source.entityId },
          entityVersionId: { eq: source.entityVersionId },
          fieldId: { eq: source.fieldId },
          sourceFileId: { eq: source.sourceFileId },
          sourceSha256Hex: { eq: source.sourceSha256Hex },
          kind: { eq: "ocr" },
          processorVersion: { eq: OCR_PROCESSOR_VERSION },
        },
        columns: { errorCode: true, id: true, status: true },
      });
      const canRetry =
        existing?.status === "failed" ||
        (existing?.status === "cancelled" &&
          existing.errorCode === "policy_disabled");
      if (!existing || !canRetry) {
        run = existing ?? null;
      } else {
        const retried = await tx
          .update(documentProcessingRuns)
          .set({
            errorAt: null,
            errorCode: null,
            finishedAt: null,
            nextAttemptAt: null,
            requestSource: "manual",
            requestedBy: userId,
            status: "queued",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documentProcessingRuns.id, existing.id),
              or(
                eq(documentProcessingRuns.status, "failed"),
                and(
                  eq(documentProcessingRuns.status, "cancelled"),
                  eq(documentProcessingRuns.errorCode, "policy_disabled"),
                ),
              ),
            ),
          )
          .returning({
            id: documentProcessingRuns.id,
            status: documentProcessingRuns.status,
          });
        run = retried.at(0) ?? existing;
      }
    }

    if (run) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.EXECUTE,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: source.entityId,
        metadata: {
          fieldId: source.fieldId,
          operation: "ocr",
          runId: run.id,
        },
      });
    }
    return run;
  });

export const requestManualOcrHandler = async function* ({
  enqueue = enqueueDocumentProcessingRun,
  entityId,
  fieldId,
  organizationId,
  persistRun = persistManualOcrRun,
  recordAuditEvent,
  safeDb,
  userId,
  workspaceId,
}: RequestManualOcrProps) {
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
    yield* Result.await(
      Result.tryPromise({
        try: async () => await enqueue(run.id),
        catch: (cause) =>
          new HandlerError({
            status: 502,
            message: "Document processing queue is unavailable",
            cause,
          }),
      }),
    );
  }

  return Result.ok({ accepted: true, runId: run.id });
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
