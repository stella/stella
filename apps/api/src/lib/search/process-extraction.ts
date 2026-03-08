/**
 * Async pipeline: download file from S3 → extract text →
 * encrypt → store → re-index.
 *
 * Called fire-and-forget after file uploads; failures are
 * captured by the caller via captureError.
 */

import { panic } from "better-result";

import { db } from "@/api/db";
import { extractedContent } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import { toSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { captureError } from "@/api/lib/posthog";
import { s3 } from "@/api/lib/s3";
import { extractFileText } from "@/api/lib/search/extract-content";
import { getSearchProvider } from "@/api/lib/search/provider";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const findFileField = (
  fields: { content: FieldContent }[],
): Extract<FieldContent, { type: "file" }> | null => {
  for (const field of fields) {
    if (field.content.type === "file") {
      return field.content;
    }
  }
  return null;
};

/**
 * Choose which S3 object to extract text from.
 * For non-PDF files that were converted to PDF by
 * Gotenberg, extract from the PDF copy (better text
 * layer). For native PDFs and DOCX, use the original.
 */
const pickExtractionSource = (
  fileField: Extract<FieldContent, { type: "file" }>,
): { fileId: string; mimeType: string } => {
  if (fileField.mimeType !== PDF_MIME_TYPE && fileField.pdfFileId) {
    return {
      fileId: fileField.pdfFileId,
      mimeType: PDF_MIME_TYPE,
    };
  }
  return { fileId: fileField.id, mimeType: fileField.mimeType };
};

/**
 * Extract text from the entity's file, encrypt it, store it,
 * and (re-)index the entity for search. This function always
 * indexes the entity at the end, even when extraction is
 * skipped, so callers don't need a separate indexEntity call.
 */
export const processExtraction = async (entityId: string): Promise<void> => {
  const entity = await db.query.entities.findFirst({
    where: { id: entityId },
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
          fields: { columns: { content: true } },
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

  const fileField = findFileField(version.fields);
  const canExtract = fileField && !fileField.encrypted;

  if (canExtract) {
    try {
      const source = pickExtractionSource(fileField);
      const orgId = toSafeId<"organization">(workspace.organizationId);
      const wsId = toSafeId<"workspace">(workspace.id);
      const key = createFileKey({
        organizationId: orgId,
        workspaceId: wsId,
        fileId: source.fileId,
        mimeType: source.mimeType,
      });

      const s3File = s3.file(key);
      const buffer = await s3File.arrayBuffer();

      const text = await extractFileText(buffer, source.mimeType, {
        entityId,
        fileId: source.fileId,
      });

      if (text) {
        const encrypted = await encryptContent(workspace.organizationId, text);

        await db
          .insert(extractedContent)
          .values({
            entityId,
            organizationId: workspace.organizationId,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            charCount: text.length,
            // TODO: populate once language detection is wired up
            language: null,
            extractedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: extractedContent.entityId,
            set: {
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              charCount: text.length,
              language: null,
              extractedAt: new Date(),
            },
          });
      }
    } catch (err) {
      // Extraction failures must not prevent search
      // indexing; the entity is still searchable by its
      // field-level text.
      captureError(err, {
        entityId,
        mimeType: fileField.mimeType,
      });
    }
  }

  // Always index: includes extracted content when available,
  // field-level text otherwise.
  await getSearchProvider().indexEntity(entityId);
};
