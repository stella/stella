import type { ScopedDb } from "@/api/db/safe-db";
import { status } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { loadCurrentOcrExport } from "@/api/lib/document-content-provenance";
import { createOcrSearchablePdfKey } from "@/api/lib/file-key";
import { getS3 } from "@/api/lib/s3";
import type { SignedDownloadSource } from "@/api/lib/s3-presign";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import type { SyntheticSessionAuthorityReader } from "@/api/lib/synthetic-principal/session-authority";
import { withTimeout } from "@/api/lib/with-timeout";
import { authorizedWorkspaceIds } from "@/api/lib/workspaces/authorized-workspace-ids";

const OCR_EXPORT_STORAGE_READ_TIMEOUT_MS = 30 * 1000;
const OCR_EXPORT_URL_EXPIRY_SECONDS = 15 * 60;
export const OCR_EXPORT_FORMATS = ["searchable-pdf", "text"] as const;
type OcrExportFormat = (typeof OCR_EXPORT_FORMATS)[number];

type ReadOcrExportOptions = {
  userId: SafeId<"user">;
  source: SignedDownloadSource;
  fieldId: SafeId<"field">;
  format: OcrExportFormat;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  readSessionAuthority: SyntheticSessionAuthorityReader;
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
  userId,
  source,
  organizationId,
  recordAuditEvent,
  readSessionAuthority,
  scopedDb,
  workspaceId,
}: ReadOcrExportOptions) => {
  const row = await scopedDb(async (tx) => {
    const authorizedIds = (
      await authorizedWorkspaceIds(tx, {
        organizationId,
        workspaceIds: [workspaceId],
      })
    ).unwrap("The scoped workspace authorization read must succeed");
    return await loadCurrentOcrExport({
      authorizedWorkspaceIds: authorizedIds,
      db: tx,
      fieldId,
      organizationId,
      workspaceId,
    });
  });
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
          readSessionAuthority,
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: row.entityId,
          userId,
          source,
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

  const text = await row.readText();
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
