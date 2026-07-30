import { and, eq, isNull } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const OCR_PROCESSOR_VERSION = 1;

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

    return await tx.query.documentProcessingRuns.findFirst({
      where: {
        organizationId: { eq: organizationId },
        workspaceId: { eq: workspaceId },
        entityId: { eq: entityId },
        entityVersionId: { eq: entityVersionId },
        fieldId: { eq: fieldId },
        sourceFileId: { eq: sourceFileId },
        sourceSha256Hex: { eq: sourceSha256Hex },
        kind: { eq: "ocr" },
        processorVersion: { eq: OCR_PROCESSOR_VERSION },
        status: { eq: "queued" },
      },
      columns: { id: true },
    });
  });

  if (run) {
    await enqueueDocumentProcessingRun(run.id);
  }
};
