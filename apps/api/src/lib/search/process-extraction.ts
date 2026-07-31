/**
 * Async pipeline: download file from S3 → extract text →
 * encrypt → store → re-index.
 *
 * Called fire-and-forget after file uploads; failures are
 * captured by the caller via captureError.
 */

import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { requestAutomaticDocumentOcr } from "@/api/lib/document-processing-automatic-request";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import {
  extractFileText,
  resolveExtractionMimeType,
} from "@/api/lib/search/extract-content";
import { getSearchProvider } from "@/api/lib/search/provider";
import { findExtractionFileField } from "@/api/lib/search/types";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/**
 * Choose which S3 object to extract text from.
 * For non-PDF files that were converted to PDF by
 * Gotenberg, extract from the PDF copy (better text
 * layer). For native PDFs and DOCX, use the original.
 */
const pickExtractionSource = (
  fileField: Extract<FieldContent, { type: "file" }>,
): { fileId: string; storageMimeType: string; extractionMimeType: string } => {
  if (fileField.mimeType !== PDF_MIME_TYPE && fileField.pdfFileId) {
    return {
      fileId: fileField.pdfFileId,
      storageMimeType: PDF_MIME_TYPE,
      extractionMimeType: PDF_MIME_TYPE,
    };
  }
  return {
    fileId: fileField.id,
    storageMimeType: fileField.mimeType,
    extractionMimeType: resolveExtractionMimeType({
      fileName: fileField.fileName,
      mimeType: fileField.mimeType,
    }),
  };
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
}: NativeExtractionProjectionOptions): Promise<boolean> =>
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
      return false;
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
          ciphertext = EXCLUDED.ciphertext,
          iv = EXCLUDED.iv,
          char_count = EXCLUDED.char_count,
          language = EXCLUDED.language,
          extracted_at = EXCLUDED.extracted_at
        WHERE NOT EXISTS (SELECT 1 FROM manual_projection_ownership)
        RETURNING entity_id AS "entityId"
      `);
    return persisted.at(0) !== undefined;
  });

/**
 * Extract text from the entity's file, encrypt it, store it,
 * and (re-)index the entity for search. This function always
 * indexes the entity at the end, even when extraction is
 * skipped, so callers don't need a separate indexEntity call.
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
  const canExtract = fileField && !fileField.encrypted;
  let shouldRequestAutomaticOcr = false;

  if (canExtract) {
    const orgId = toSafeId<"organization">(workspace.organizationId);
    const wsId = toSafeId<"workspace">(workspace.id);
    const extraction = await Result.tryPromise({
      try: async () => {
        const source = pickExtractionSource(fileField);
        const key = createFileKey({
          organizationId: orgId,
          workspaceId: wsId,
          fileId: source.fileId,
          mimeType: source.storageMimeType,
        });
        const buffer = await getS3().file(key).arrayBuffer();
        return await extractFileText(buffer, source.extractionMimeType, {
          entityId,
          fileId: source.fileId,
        });
      },
      catch: (cause) => cause,
    });
    if (Result.isError(extraction)) {
      // Extraction failures must not prevent search
      // indexing; the entity is still searchable by its
      // field-level text.
      captureError(extraction.error, {
        entityId,
        mimeType: fileField.mimeType,
      });
      shouldRequestAutomaticOcr = fileField.mimeType === PDF_MIME_TYPE;
    } else {
      const text = extraction.value;
      shouldRequestAutomaticOcr = fileField.mimeType === PDF_MIME_TYPE && !text;
      if (text) {
        // Native extraction succeeded. Encryption and durable projection
        // failures must propagate to the caller; they are not evidence that
        // the legal document needs to be sent to an external OCR provider.
        const encrypted = await encryptContent(workspace.organizationId, text);
        const sourceField =
          fileFieldRow ?? panic("Extraction source field is missing");
        await persistNativeExtractionProjection({
          charCount: text.length,
          ciphertext: encrypted.ciphertext,
          entityId,
          entityVersionId: version.id,
          fieldId: sourceField.id,
          iv: encrypted.iv,
          organizationId: orgId,
          sourceFileId: fileField.id,
          sourceSha256Hex: fileField.sha256Hex,
          workspaceId: wsId,
        });
      }
    }
  }

  if (shouldRequestAutomaticOcr && fileFieldRow && fileField) {
    await requestAutomaticDocumentOcr({
      entityId,
      entityVersionId: version.id,
      fieldId: fileFieldRow.id,
      organizationId: workspace.organizationId,
      requestSource: "upload",
      sourceFileId: fileField.id,
      sourceSha256Hex: fileField.sha256Hex,
      workspaceId: workspace.id,
    }).catch((error: unknown) => {
      captureError(error, {
        entityId,
        fieldId: fileFieldRow.id,
        mimeType: fileField.mimeType,
      });
    });
  }

  // Always index: includes extracted content when available,
  // field-level text otherwise.
  await getSearchProvider().indexEntity(entityId);
};
