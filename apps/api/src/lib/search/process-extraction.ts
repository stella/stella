/** Durable native extraction request and worker-side execution. */

import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { documentProcessingRuns } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { requestAutomaticDocumentOcr } from "@/api/lib/document-processing-automatic-request";
import { DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { restoreManualOcrRunAfterProjectionLoss } from "@/api/lib/document-processing-manual-ocr-restore";
import { shouldGeneratePdfDerivative } from "@/api/lib/files/pdf-derivative-policy";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import { getS3ObjectWithSignal } from "@/api/lib/s3";
import {
  extractFileTextResult,
  resolveExtractionMimeType,
} from "@/api/lib/search/extract-content";
import { canExtractMimeType } from "@/api/lib/search/extractable-mime-types";
import { getSearchProvider } from "@/api/lib/search/provider";
import { findExtractionFileField } from "@/api/lib/search/types";
import { withTimeout } from "@/api/lib/with-timeout";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type ExtractionSource = {
  fileId: string;
  storageMimeType: string;
  extractionMimeType: string;
};

/**
 * Choose which S3 object to extract text from.
 *
 * The original file wins whenever a parser handles its format
 * directly. Going through the Gotenberg PDF derivative instead
 * would read text off a paginated rendering: spreadsheet columns
 * are scaled to fit a page and anything past the last fitted
 * column never reaches the PDF at all.
 *
 * Formats with no direct parser (images, HTML, iWork) still fall
 * back to the PDF copy, which is the only text layer they have.
 */
export const pickExtractionSource = (
  fileField: Extract<FieldContent, { type: "file" }>,
): ExtractionSource => {
  const extractionMimeType = resolveExtractionMimeType({
    fileName: fileField.fileName,
    mimeType: fileField.mimeType,
  });

  if (!canExtractMimeType(extractionMimeType) && fileField.pdfFileId) {
    return {
      fileId: fileField.pdfFileId,
      storageMimeType: PDF_MIME_TYPE,
      extractionMimeType: PDF_MIME_TYPE,
    };
  }

  return {
    fileId: fileField.id,
    storageMimeType: fileField.mimeType,
    extractionMimeType,
  };
};

export const requiresDurableNativeExtraction = (
  fileField: Extract<FieldContent, { type: "file" }>,
): boolean => {
  if (fileField.encrypted) {
    return false;
  }
  if (
    fileField.pdfFileId === null &&
    shouldGeneratePdfDerivative({
      encrypted: fileField.encrypted,
      mimeType: fileField.mimeType,
    })
  ) {
    return false;
  }
  return canExtractMimeType(pickExtractionSource(fileField).extractionMimeType);
};

type NativeExtractionProjectionOptions = {
  charCount: number;
  ciphertext: Buffer;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  iv: Buffer;
  organizationId: SafeId<"organization">;
  sourceFileId: string;
  sourceSha256Hex: string;
  workspaceId: SafeId<"workspace">;
};

type PersistedNativeExtractionProjection = {
  entityId: SafeId<"entity">;
};

export type NativeExtractionProjectionOutcome =
  | "persisted"
  | "preserved"
  | "source_cancelled";

export const persistNativeExtractionProjection = async ({
  charCount,
  ciphertext,
  entityId,
  entityVersionId,
  fieldId,
  iv,
  organizationId,
  sourceFileId,
  sourceSha256Hex,
  workspaceId,
}: NativeExtractionProjectionOptions): Promise<NativeExtractionProjectionOutcome> =>
  await rootDb.transaction(async (tx) => {
    // Manual OCR request and projection transactions take this same lock first.
    // Keeping the conditional write in the next statement gives it a fresh
    // READ COMMITTED snapshot after any lock waiter ahead of us commits.
    const lockedSources =
      await tx.execute<PersistedNativeExtractionProjection>(sql`
        SELECT e.id AS "entityId"
        FROM entities e
        INNER JOIN fields f
          ON f.id = ${fieldId}
          AND f.workspace_id = ${workspaceId}
          AND f.entity_version_id = ${entityVersionId}
        WHERE e.id = ${entityId}
          AND e.workspace_id = ${workspaceId}
          AND e.current_version_id = ${entityVersionId}
          AND f.content->>'type' = 'file'
          AND f.content->>'id' = ${sourceFileId}
          AND f.content->>'sha256Hex' = ${sourceSha256Hex}
        FOR UPDATE OF e
      `);
    if (!lockedSources.at(0)) {
      return "source_cancelled";
    }

    const persisted = await tx.execute<PersistedNativeExtractionProjection>(sql`
        WITH manual_projection_ownership AS MATERIALIZED (
          SELECT 1
          FROM document_processing_runs manual_run
          WHERE manual_run.organization_id = ${organizationId}
            AND manual_run.workspace_id = ${workspaceId}
            AND manual_run.entity_id = ${entityId}
            AND manual_run.entity_version_id = ${entityVersionId}
            AND manual_run.kind = 'ocr'
            AND manual_run.request_source = 'manual'
            AND (
              manual_run.status IN ('queued', 'running')
              OR (
                (
                  manual_run.status = 'succeeded'
                  OR (
                    manual_run.status = 'failed'
                    AND manual_run.error_code = 'search_index_failed'
                  )
                )
                AND EXISTS (
                  SELECT 1
                  FROM extracted_content selected_projection
                  WHERE selected_projection.organization_id = ${organizationId}
                    AND selected_projection.workspace_id = ${workspaceId}
                    AND selected_projection.entity_id = ${entityId}
                    AND selected_projection.source_entity_version_id = manual_run.entity_version_id
                    AND selected_projection.source_field_id = manual_run.field_id
                    AND selected_projection.source_file_id = manual_run.source_file_id
                    AND selected_projection.source_sha256_hex = manual_run.source_sha256_hex
                )
              )
            )
          LIMIT 1
        )
        INSERT INTO extracted_content (
          entity_id, organization_id, workspace_id,
          source_entity_version_id, source_field_id,
          source_file_id, source_sha256_hex,
          ciphertext, iv, char_count, language, extracted_at
        )
        SELECT
          ${entityId}, ${organizationId}, ${workspaceId},
          ${entityVersionId}, ${fieldId},
          ${sourceFileId}, ${sourceSha256Hex},
          ${ciphertext}, ${iv}, ${charCount}, NULL, now()
        FROM entities e
        INNER JOIN fields f
          ON f.id = ${fieldId}
          AND f.workspace_id = ${workspaceId}
          AND f.entity_version_id = ${entityVersionId}
        WHERE e.id = ${entityId}
          AND e.workspace_id = ${workspaceId}
          AND e.current_version_id = ${entityVersionId}
          AND f.content->>'type' = 'file'
          AND f.content->>'id' = ${sourceFileId}
          AND f.content->>'sha256Hex' = ${sourceSha256Hex}
          AND NOT EXISTS (SELECT 1 FROM manual_projection_ownership)
        ON CONFLICT (entity_id) DO UPDATE SET
          organization_id = EXCLUDED.organization_id,
          workspace_id = EXCLUDED.workspace_id,
          source_entity_version_id = EXCLUDED.source_entity_version_id,
          source_field_id = EXCLUDED.source_field_id,
          source_file_id = EXCLUDED.source_file_id,
          source_sha256_hex = EXCLUDED.source_sha256_hex,
          ocr_run_id = NULL,
          ocr_processor_version = NULL,
          ocr_payload_ciphertext = NULL,
          ocr_payload_iv = NULL,
          ciphertext = EXCLUDED.ciphertext,
          iv = EXCLUDED.iv,
          char_count = EXCLUDED.char_count,
          language = EXCLUDED.language,
          extracted_at = EXCLUDED.extracted_at
        WHERE NOT EXISTS (SELECT 1 FROM manual_projection_ownership)
        RETURNING entity_id AS "entityId"
      `);
    return persisted.at(0) === undefined ? "preserved" : "persisted";
  });

type NativeExtractionRun = Pick<
  typeof documentProcessingRuns.$inferSelect,
  | "entityId"
  | "entityVersionId"
  | "fieldId"
  | "organizationId"
  | "sourceFileId"
  | "sourceSha256Hex"
  | "workspaceId"
>;

export const executeNativeExtraction = async ({
  fileField,
  lifecycleSignal,
  run,
}: {
  fileField: Extract<FieldContent, { type: "file" }>;
  lifecycleSignal: AbortSignal;
  run: NativeExtractionRun;
}): Promise<NativeExtractionProjectionOutcome> => {
  const source = pickExtractionSource(fileField);
  const key = createFileKey({
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    fileId: source.fileId,
    mimeType: source.storageMimeType,
  });
  const buffer = await withTimeout(
    async (signal) => await getS3ObjectWithSignal(key, signal),
    {
      label: "native extraction source read",
      signal: lifecycleSignal,
      timeoutMs: LIMITS.documentProcessingObjectReadTimeoutMs,
    },
  );
  lifecycleSignal.throwIfAborted();
  const extraction = await extractFileTextResult(
    buffer,
    source.extractionMimeType,
  );
  if (Result.isError(extraction)) {
    throw extraction.error;
  }
  lifecycleSignal.throwIfAborted();

  const text = extraction.value;
  const persistedText = text ?? "";
  const encrypted = await encryptContent(run.organizationId, persistedText);
  lifecycleSignal.throwIfAborted();
  const persistenceOutcome = await persistNativeExtractionProjection({
    charCount: persistedText.length,
    ciphertext: encrypted.ciphertext,
    entityId: run.entityId,
    entityVersionId: run.entityVersionId,
    fieldId: run.fieldId,
    iv: encrypted.iv,
    organizationId: run.organizationId,
    sourceFileId: run.sourceFileId,
    sourceSha256Hex: run.sourceSha256Hex,
    workspaceId: run.workspaceId,
  });
  if (persistenceOutcome === "source_cancelled") {
    return persistenceOutcome;
  }

  if (source.extractionMimeType === PDF_MIME_TYPE) {
    await restoreManualOcrRunAfterProjectionLoss({
      entityId: run.entityId,
      entityVersionId: run.entityVersionId,
      fieldId: run.fieldId,
      organizationId: run.organizationId,
      sourceFileId: run.sourceFileId,
      sourceSha256Hex: run.sourceSha256Hex,
      workspaceId: run.workspaceId,
    });
  }

  if (persistenceOutcome !== "persisted") {
    return persistenceOutcome;
  }

  if (text === null && source.extractionMimeType === PDF_MIME_TYPE) {
    await requestAutomaticDocumentOcr({
      entityId: run.entityId,
      entityVersionId: run.entityVersionId,
      fieldId: run.fieldId,
      organizationId: run.organizationId,
      requestSource: "upload",
      sourceFileId: run.sourceFileId,
      sourceSha256Hex: run.sourceSha256Hex,
      workspaceId: run.workspaceId,
    });
  }
  return persistenceOutcome;
};

/**
 * Durably request native extraction for the entity's selected file. The
 * document-processing worker owns extraction, persistence, indexing, and
 * retries; callers may still treat this as best-effort because the committed
 * run and bounded repair scan own eventual completion.
 */
export const processExtraction = async (
  entityId: SafeId<"entity">,
  options?: {
    filePropertyId?: SafeId<"property"> | undefined;
  },
): Promise<void> => {
  const entity = await rootDb.query.entities.findFirst({
    where: { id: { eq: entityId } },
    columns: { id: true, workspaceId: true },
    with: {
      workspace: {
        columns: {
          id: true,
          organizationId: true,
        },
      },
      currentVersion: {
        columns: { id: true },
        with: {
          // Fields of one entity version: at most one row per property
          // (fields_property_id_entity_version_id_key), so this is
          // structurally bounded by properties-per-workspace; `limit` pins
          // that same bound explicitly for the lint rule below.
          // `id` is a Bun.randomUUIDv7() primary key (time-ordered), so
          // ordering by it gives a stable field-creation order. This MUST
          // match the ordering `readEntityByIdHandler` applies to the same
          // relation -- both feed `findExtractionFileField`'s "first file
          // field" selection, which must resolve to the SAME field
          // wherever it runs (see findExtractionFileField).
          fields: {
            columns: { content: true, id: true, propertyId: true },
            orderBy: { id: "asc" },
            limit: LIMITS.propertiesCount,
          },
        },
      },
    },
  });

  if (!entity) {
    return;
  }

  const workspace = entity.workspace ?? panic("Entity has no workspace");
  const version =
    entity.currentVersion ?? panic("Entity has no currentVersion");

  const fileField = findExtractionFileField(
    version.fields,
    options?.filePropertyId,
  );
  const fileFieldRow = version.fields.find(
    (field) =>
      field.content.type === "file" &&
      field.content.id === fileField?.id &&
      (options?.filePropertyId === undefined ||
        field.propertyId === options.filePropertyId),
  );
  if (
    !(fileField && fileFieldRow && requiresDurableNativeExtraction(fileField))
  ) {
    await getSearchProvider().indexEntity(entityId);
    return;
  }

  const organizationId = toSafeId<"organization">(workspace.organizationId);
  const workspaceId = toSafeId<"workspace">(workspace.id);
  const inserted = await rootDb
    .insert(documentProcessingRuns)
    .values({
      id: createSafeId<"documentProcessingRun">(),
      entityId,
      entityVersionId: version.id,
      fieldId: fileFieldRow.id,
      kind: "native-extraction",
      organizationId,
      processorVersion: DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
      requestedBy: null,
      requestSource: "upload",
      sourceFileId: fileField.id,
      sourceSha256Hex: fileField.sha256Hex,
      workspaceId,
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
    await enqueueDocumentProcessingRun(created.id);
    return;
  }
  const existing = (
    await rootDb
      .select({
        id: documentProcessingRuns.id,
        status: documentProcessingRuns.status,
      })
      .from(documentProcessingRuns)
      .where(
        and(
          eq(documentProcessingRuns.organizationId, organizationId),
          eq(documentProcessingRuns.workspaceId, workspaceId),
          eq(documentProcessingRuns.entityId, entityId),
          eq(documentProcessingRuns.entityVersionId, version.id),
          eq(documentProcessingRuns.fieldId, fileFieldRow.id),
          eq(documentProcessingRuns.sourceFileId, fileField.id),
          eq(documentProcessingRuns.sourceSha256Hex, fileField.sha256Hex),
          eq(documentProcessingRuns.kind, "native-extraction"),
          eq(
            documentProcessingRuns.processorVersion,
            DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
          ),
        ),
      )
      .limit(1)
  ).at(0);
  if (!existing) {
    return;
  }
  if (existing.status === "queued") {
    await enqueueDocumentProcessingRun(existing.id);
    return;
  }
  if (existing.status !== "succeeded") {
    return;
  }

  const projection = await rootDb.query.extractedContent.findFirst({
    where: {
      entityId: { eq: entityId },
      organizationId: { eq: organizationId },
      sourceEntityVersionId: { eq: version.id },
      sourceFieldId: { eq: fileFieldRow.id },
      sourceFileId: { eq: fileField.id },
      sourceSha256Hex: { eq: fileField.sha256Hex },
      workspaceId: { eq: workspaceId },
    },
    columns: { entityId: true },
  });
  if (projection) {
    // The durable extraction still matches; rebuild a projection that may
    // have been deliberately removed during version rollback.
    await getSearchProvider().indexEntity(entityId);
    return;
  }

  // The unique run belongs to this immutable source, but its succeeded
  // projection was replaced by a later version. Requeue it conditionally so
  // rollback can reconstruct the promoted version without racing a worker.
  const requeued = await rootDb
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
  const retry = requeued.at(0);
  if (retry) {
    await enqueueDocumentProcessingRun(retry.id);
  }
};
