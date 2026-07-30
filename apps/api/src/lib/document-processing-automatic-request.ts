import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { detached } from "@/api/lib/detached";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const OCR_PROCESSOR_VERSION = 1;
const AUTOMATIC_OCR_ENQUEUE_TIMEOUT_MS = 2000;

export const enqueueAutomaticDocumentOcrRun = async ({
  captureEnqueueError = captureError,
  enqueue = enqueueDocumentProcessingRun,
  runId,
  timeoutMs = AUTOMATIC_OCR_ENQUEUE_TIMEOUT_MS,
}: {
  captureEnqueueError?: typeof captureError;
  enqueue?: typeof enqueueDocumentProcessingRun;
  runId: SafeId<"documentProcessingRun">;
  timeoutMs?: number;
}): Promise<void> => {
  const enqueueResult = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await enqueue(runId), {
        label: "automatic OCR queue handoff",
        timeoutMs,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(enqueueResult)) {
    // The committed queued run is the source of truth. Reconciliation will
    // retry delivery; uploads must not wait indefinitely on Redis.
    captureEnqueueError(enqueueResult.error, { runId });
  }
};

export const requestAutomaticDocumentOcr = async ({
  entityId,
  entityVersionId,
  fieldId,
  organizationId,
  requestSource,
  sourceFileId,
  sourceSha256Hex,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  requestSource: "repair" | "upload";
  sourceFileId: string;
  sourceSha256Hex: string;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  const run = await rootDb.transaction(async (tx) => {
    const settings = await tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: { documentProcessingMode: true },
    });
    if (settings?.documentProcessingMode !== "searchable-text") {
      return null;
    }

    const currentRows = await tx
      .select({ content: fields.content })
      .from(entities)
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, entityVersionId),
          eq(entityVersions.entityId, entities.id),
          eq(entityVersions.workspaceId, workspaceId),
          isNull(entityVersions.deletedAt),
        ),
      )
      .innerJoin(
        fields,
        and(
          eq(fields.id, fieldId),
          eq(fields.entityVersionId, entityVersionId),
          eq(fields.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(entities.id, entityId),
          eq(entities.workspaceId, workspaceId),
          eq(entities.currentVersionId, entityVersionId),
          eq(entities.readOnly, false),
        ),
      )
      .limit(1)
      .for("update");
    const content = currentRows.at(0)?.content;
    if (
      content?.type !== "file" ||
      content.id !== sourceFileId ||
      content.sha256Hex !== sourceSha256Hex ||
      content.mimeType !== PDF_MIME_TYPE ||
      content.encrypted
    ) {
      return null;
    }

    const inserted = await tx
      .insert(documentProcessingRuns)
      .values({
        id: createSafeId<"documentProcessingRun">(),
        organizationId,
        workspaceId,
        entityId,
        entityVersionId,
        fieldId,
        sourceFileId,
        sourceSha256Hex,
        kind: "ocr",
        processorVersion: OCR_PROCESSOR_VERSION,
        requestSource,
        requestedBy: null,
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
      .returning({ id: documentProcessingRuns.id });
    const created = inserted.at(0);
    if (created) {
      return created;
    }

    const existingRows = await tx
      .select({ id: documentProcessingRuns.id })
      .from(documentProcessingRuns)
      .where(
        and(
          eq(documentProcessingRuns.organizationId, organizationId),
          eq(documentProcessingRuns.workspaceId, workspaceId),
          eq(documentProcessingRuns.entityId, entityId),
          eq(documentProcessingRuns.entityVersionId, entityVersionId),
          eq(documentProcessingRuns.fieldId, fieldId),
          eq(documentProcessingRuns.sourceFileId, sourceFileId),
          eq(documentProcessingRuns.sourceSha256Hex, sourceSha256Hex),
          eq(documentProcessingRuns.kind, "ocr"),
          eq(documentProcessingRuns.processorVersion, OCR_PROCESSOR_VERSION),
          eq(documentProcessingRuns.status, "queued"),
        ),
      )
      .limit(1);
    return existingRows.at(0);
  });

  if (run) {
    // This is only a latency optimization: the durable queued row and bounded
    // reconciler own delivery. Do not extend upload completion by Redis latency.
    detached(
      enqueueAutomaticDocumentOcrRun({ runId: run.id }),
      "automatic-document-ocr.enqueue",
    );
  }
};
