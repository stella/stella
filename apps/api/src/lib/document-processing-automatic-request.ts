import { and, eq, isNull } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { shouldRequeueOcrRunAfterProjectionLoss } from "@/api/lib/document-processing-automatic-request-state";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { resolveExtractionMimeType } from "@/api/lib/search/extract-content";
import { PDF_MIME_TYPE } from "@/api/mime-types";

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
  await rootDb.transaction(async (tx) => {
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
      resolveExtractionMimeType({
        fileName: content.fileName,
        mimeType: content.mimeType,
      }) !== PDF_MIME_TYPE ||
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
        processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
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
      .select({
        id: documentProcessingRuns.id,
        requestSource: documentProcessingRuns.requestSource,
        status: documentProcessingRuns.status,
      })
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
          eq(
            documentProcessingRuns.processorVersion,
            DOCUMENT_OCR_PROCESSOR_VERSION,
          ),
        ),
      )
      .limit(1)
      .for("update");
    const existing = existingRows.at(0);
    if (!existing) {
      return null;
    }
    if (existing.requestSource === "manual") {
      return null;
    }

    const projectionRows =
      existing.status === "succeeded"
        ? await tx
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
                eq(extractedContent.entityId, entityId),
                eq(extractedContent.organizationId, organizationId),
                eq(extractedContent.workspaceId, workspaceId),
              ),
            )
            .limit(1)
        : [];
    if (
      !shouldRequeueOcrRunAfterProjectionLoss({
        projection: projectionRows.at(0) ?? null,
        run: existing,
        source: {
          entityVersionId,
          fieldId,
          sourceFileId,
          sourceSha256Hex,
        },
      })
    ) {
      return existing.status === "queued" ? existing : null;
    }

    const retried = await tx
      .update(documentProcessingRuns)
      .set({
        claimedAt: null,
        claimedBy: null,
        errorAt: null,
        errorCode: null,
        finishedAt: null,
        nextAttemptAt: null,
        progressCompleted: 0,
        progressTotal: null,
        startedAt: null,
        status: "queued",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documentProcessingRuns.id, existing.id),
          eq(documentProcessingRuns.status, "succeeded"),
        ),
      )
      .returning({ id: documentProcessingRuns.id });
    return retried.at(0) ?? null;
  });

  // The configured batch scheduler releases the durable queued row. Uploads
  // must never hand OCR work directly to BullMQ because doing so would wake
  // the processor outside the shared batch window.
};
