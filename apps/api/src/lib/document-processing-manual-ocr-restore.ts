import { and, eq, inArray, or } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  extractedContent,
  fields,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isExactOcrProjection } from "@/api/lib/document-processing-automatic-request-state";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";

const RETRYABLE_MANUAL_OCR_CANCELLATION_CODES = [
  "policy_disabled",
  "manual_selection_superseded",
  "source_superseded",
  "workspace_unavailable",
] as const;
const SEARCH_INDEX_FAILURE_CODE = "search_index_failed";

const restorableRunFilter = () =>
  or(
    eq(documentProcessingRuns.status, "succeeded"),
    and(
      eq(documentProcessingRuns.status, "failed"),
      eq(documentProcessingRuns.errorCode, SEARCH_INDEX_FAILURE_CODE),
    ),
    and(
      eq(documentProcessingRuns.status, "cancelled"),
      inArray(
        documentProcessingRuns.errorCode,
        RETRYABLE_MANUAL_OCR_CANCELLATION_CODES,
      ),
    ),
  );

export const restoreManualOcrRunAfterProjectionLoss = async ({
  entityId,
  entityVersionId,
  fieldId,
  organizationId,
  sourceFileId,
  sourceSha256Hex,
  workspaceId,
  db = rootDb,
}: {
  db?: Pick<typeof rootDb, "transaction">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  sourceFileId: string;
  sourceSha256Hex: string;
  workspaceId: SafeId<"workspace">;
}): Promise<void> => {
  await db.transaction(async (tx) => {
    const currentRows = await tx
      .select({ id: entities.id })
      .from(entities)
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
    if (!currentRows.at(0)) {
      return;
    }
    const workspaceRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.organizationId, organizationId),
          eq(workspaces.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (!workspaceRows.at(0)) {
      return;
    }
    const sourceFieldRows = await tx
      .select({ content: fields.content })
      .from(fields)
      .where(
        and(
          eq(fields.id, fieldId),
          eq(fields.workspaceId, workspaceId),
          eq(fields.entityVersionId, entityVersionId),
        ),
      )
      .limit(1);
    const sourceField = sourceFieldRows.at(0);
    if (
      sourceField?.content.type !== "file" ||
      sourceField.content.id !== sourceFileId ||
      sourceField.content.sha256Hex !== sourceSha256Hex
    ) {
      return;
    }

    const existingRows = await tx
      .select({
        errorCode: documentProcessingRuns.errorCode,
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
          eq(documentProcessingRuns.requestSource, "manual"),
          eq(
            documentProcessingRuns.processorVersion,
            DOCUMENT_OCR_PROCESSOR_VERSION,
          ),
          restorableRunFilter(),
        ),
      )
      .limit(1)
      .for("update");
    const existing = existingRows.at(0);
    if (!existing) {
      return;
    }

    const projectionRows = await tx
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
      .limit(1);
    if (
      isExactOcrProjection({
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
      return;
    }

    await tx
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
          eq(documentProcessingRuns.requestSource, "manual"),
          restorableRunFilter(),
        ),
      );
  });
};
