import { and, eq, isNull } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  extractedContent,
  fields,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { createOcrSearchablePdfKey } from "@/api/lib/file-key";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { withTimeout } from "@/api/lib/with-timeout";

const OCR_EXPORT_STORAGE_READ_TIMEOUT_MS = 30 * 1000;
const OCR_EXPORT_URL_EXPIRY_SECONDS = 15 * 60;
export const OCR_EXPORT_FORMATS = ["searchable-pdf", "text"] as const;
export type OcrExportFormat = (typeof OCR_EXPORT_FORMATS)[number];

type ReadOcrExportOptions = {
  fieldId: SafeId<"field">;
  format: OcrExportFormat;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

const replaceExtension = (fileName: string, suffix: string) => {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex <= 0 ? fileName : fileName.slice(0, dotIndex);
  return sanitizeFilenamePreservingExtension(`${baseName}${suffix}`);
};

export const readOcrExport = async ({
  fieldId,
  format,
  organizationId,
  recordAuditEvent,
  scopedDb,
  workspaceId,
}: ReadOcrExportOptions) => {
  const rows = await scopedDb((tx) =>
    tx
      .select({
        ciphertext: extractedContent.ciphertext,
        entityId: entities.id,
        content: fields.content,
        iv: extractedContent.iv,
        ocrRunId: extractedContent.ocrRunId,
      })
      .from(extractedContent)
      .innerJoin(
        entities,
        and(
          eq(entities.id, extractedContent.entityId),
          eq(entities.workspaceId, workspaceId),
          eq(entities.currentVersionId, extractedContent.sourceEntityVersionId),
        ),
      )
      .innerJoin(
        entityVersions,
        and(
          eq(entityVersions.id, extractedContent.sourceEntityVersionId),
          eq(entityVersions.entityId, entities.id),
          eq(entityVersions.workspaceId, workspaceId),
          isNull(entityVersions.deletedAt),
        ),
      )
      .innerJoin(
        fields,
        and(
          eq(fields.id, fieldId),
          eq(fields.id, extractedContent.sourceFieldId),
          eq(fields.entityVersionId, entityVersions.id),
          eq(fields.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(extractedContent.organizationId, organizationId),
          eq(extractedContent.workspaceId, workspaceId),
        ),
      )
      .limit(1),
  );
  const row = rows.at(0);
  if (!row || row.content.type !== "file" || row.ocrRunId === null) {
    return status(404);
  }

  if (format === "searchable-pdf") {
    const fileName = replaceExtension(row.content.fileName, "-searchable.pdf");
    const s3Key = createOcrSearchablePdfKey({
      organizationId,
      workspaceId,
      runId: row.ocrRunId,
    });
    const exists = await withTimeout(async () => await getS3().exists(s3Key), {
      label: "OCR export storage lookup",
      timeoutMs: OCR_EXPORT_STORAGE_READ_TIMEOUT_MS,
    });
    if (!exists) {
      return status(404);
    }
    const url = await scopedDb(
      async (tx) =>
        await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: row.entityId,
          s3Key,
          expiresInSeconds: OCR_EXPORT_URL_EXPIRY_SECONDS,
          fileName,
          organizationId,
          workspaceId,
          metadata: { fieldId, format },
        }),
    );
    return Response.redirect(url, 302);
  }

  const text = await decryptContent(organizationId, row.ciphertext, row.iv);
  const bytes = new TextEncoder().encode(text);
  const fileName = replaceExtension(row.content.fileName, ".txt");
  await scopedDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DOWNLOAD,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: row.entityId,
        metadata: { fieldId, format },
      }),
  );
  return secureDocumentResponse({
    body: bytes,
    contentLength: bytes.byteLength,
    contentType: "text/plain; charset=utf-8",
    disposition: "attachment",
    fileName,
  });
};
