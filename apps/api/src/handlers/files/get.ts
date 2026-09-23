import { Result } from "better-result";
import { status } from "elysia";

import { DOCUMENT_PROPERTIES_MAX_BYTES } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { injectStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { scrubDocumentProperties } from "@/api/lib/files/document-properties";
import { createEmailAttachmentDescriptor } from "@/api/lib/files/email-attachment-token";
import {
  emailToPreview,
  resolveEmailMimeType,
} from "@/api/lib/files/email-to-html";
import { convertToPdf, isConvertibleMimeType } from "@/api/lib/files/gotenberg";
import {
  FILE_READ_URL_EXPIRY_SECONDS,
  fileFieldQuery,
} from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import { getS3, readS3ArrayBuffer } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  parseContentLengthHeader,
  secureDocumentResponse,
} from "@/api/lib/secure-document-response";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type ReadEmailHtmlPreviewHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

export const readEmailHtmlPreviewHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
}: ReadEmailHtmlPreviewHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);

  if (!row) {
    return status(404);
  }

  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;
  const emailMimeType = resolveEmailMimeType({
    fileName: content.fileName,
    mimeType: content.mimeType,
  });
  if (content.encrypted || !emailMimeType) {
    return status(400);
  }

  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  const fileBuffer = await readS3ArrayBuffer(fileKey);
  const previewResult = await emailToPreview(fileBuffer, emailMimeType, {
    createAttachmentId: (attachmentIndex) =>
      createEmailAttachmentDescriptor({
        attachmentIndex,
        secret: env.BETTER_AUTH_SECRET,
        sourceFileId: content.id,
        sourceVersionId: row.entityVersionId,
      }),
  });

  if (Result.isError(previewResult)) {
    captureError(previewResult.error, {
      fieldId,
      mimeType: emailMimeType,
      workspaceId,
    });
    return status(422, { message: "Failed to render email preview" });
  }

  return {
    ...previewResult.value,
    source: {
      entityId: row.entityId,
      entityName: row.entityName,
      fieldId,
      fileName: content.fileName,
      mimeType: content.mimeType,
      pdfFileId: content.pdfFileId,
      propertyId: row.propertyId,
    },
  };
};

// ── Stamped download (separate endpoint) ────────────────

type StampedDownloadHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  metadata: StampedDownloadMetadata;
};

export const STAMPED_DOWNLOAD_METADATA = ["keep", "strip"] as const;
type StampedDownloadMetadata = (typeof STAMPED_DOWNLOAD_METADATA)[number];

type PrintPdfHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
};

const pdfFileName = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${fileName}.pdf`;
  }
  return `${fileName.slice(0, dotIndex)}.pdf`;
};

const fetchStoredFileResponse = async (
  key: string,
): Promise<Response | null> => {
  // Both callers translate `null` into a 502, so the status is already the
  // right one; what the discarded rejection cost was any way to tell a
  // storage outage from a timeout.
  const response = await fetchWithTimeout(
    getS3().presign(key, { expiresIn: FILE_READ_URL_EXPIRY_SECONDS }),
    {
      timeoutMs: 30_000,
    },
  ).catch((error: unknown) => {
    captureError(error, { source: "stored-file-fetch" });
    return null;
  });

  if (!response?.ok) {
    return null;
  }

  return response;
};

const pdfResponse = (buffer: ArrayBuffer, fileName: string) =>
  secureDocumentResponse({
    body: buffer,
    contentLength: buffer.byteLength,
    contentType: PDF_MIME_TYPE,
    disposition: "inline",
    fileName: sanitizeFilename(fileName),
  });

const streamedPdfResponse = (response: Response, fileName: string) => {
  const contentLength = parseContentLengthHeader(
    response.headers.get("Content-Length"),
  );
  return secureDocumentResponse({
    body: response.body,
    ...(contentLength === undefined ? {} : { contentLength }),
    contentType: PDF_MIME_TYPE,
    disposition: "inline",
    fileName: sanitizeFilename(fileName),
  });
};

export const printPdfHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
  recordAuditEvent,
}: PrintPdfHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);

  if (!row) {
    return status(404);
  }

  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;
  const outputName = pdfFileName(content.fileName);

  if (content.encrypted) {
    return status(400);
  }

  // Record the DOWNLOAD access only once the response bytes are in hand: this
  // endpoint streams full content, so it needs the same audit row the
  // presigned-download path emits (GDPR Art. 30 / SOC 2 access record), but a
  // failed S3 fetch or conversion must not leave a spurious download record.
  const recordDownload = async () =>
    await scopedDb(
      async (tx) =>
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: row.entityId,
          metadata: { format: "pdf" },
        }),
    );

  if (content.mimeType === PDF_MIME_TYPE || content.pdfFileId) {
    const fileKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: content.pdfFileId ?? content.id,
      mimeType: PDF_MIME_TYPE,
    });
    const response = await fetchStoredFileResponse(fileKey);

    if (!response) {
      return status(502);
    }

    await recordDownload();
    return streamedPdfResponse(response, outputName);
  }

  if (!isConvertibleMimeType(content.mimeType)) {
    return status(400);
  }

  const sourceKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  const source = await Result.tryPromise(
    async () =>
      await readStoredFile({
        key: sourceKey,
        mimeType: content.mimeType,
        fileName: content.fileName,
      }),
  );

  if (Result.isError(source)) {
    captureError(source.error, { source: "stored-file-fetch" });
    return status(502);
  }

  const conversionResult = await convertToPdf(source.value);

  if (Result.isError(conversionResult)) {
    captureError(conversionResult.error, {
      fieldId,
      mimeType: content.mimeType,
      sizeBytes: String(content.sizeBytes),
    });
    return status(502);
  }

  await recordDownload();
  return pdfResponse(conversionResult.value.buffer, outputName);
};

/**
 * Download a DOCX with the stella document reference injected. Returns the
 * modified file as a streamed `Response`. Only called when the user
 * explicitly asks for it: the download menu offers it as
 * "Download with reference".
 */
export const stampedDownloadHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
  recordAuditEvent,
  metadata,
}: StampedDownloadHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);

  if (!row) {
    return status(404);
  }

  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;

  if (
    !row.versionStamp ||
    !row.verificationCode ||
    !isStampableDocx(content.mimeType, content.sizeBytes) ||
    content.encrypted ||
    (metadata === "strip" && content.sizeBytes > DOCUMENT_PROPERTIES_MAX_BYTES)
  ) {
    return status(400);
  }

  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });

  const presignedUrl = getS3().presign(fileKey, {
    expiresIn: FILE_READ_URL_EXPIRY_SECONDS,
  });
  const response = await fetchWithTimeout(presignedUrl, {
    timeoutMs: 30_000,
  });

  if (!response.ok) {
    return status(502);
  }

  const buffer = await response.arrayBuffer();
  const stamped = await injectStamp(
    buffer,
    row.versionStamp,
    row.verificationCode,
    env.FRONTEND_URL,
  );
  const scrubbed =
    metadata === "strip"
      ? await scrubDocumentProperties({
          bytes: stamped,
          mimeType: content.mimeType,
        })
      : null;

  if (scrubbed !== null && scrubbed.status !== "scrubbed") {
    return status(422);
  }
  const renditionBytes =
    scrubbed === null ? new Uint8Array(stamped) : scrubbed.bytes;

  // Record the access only once the requested rendition exists, matching the
  // presigned-download path's DOWNLOAD audit row. A failed read or transform
  // must not leave a spurious download record.
  await scopedDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DOWNLOAD,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: row.entityId,
        metadata: {
          format: "docx",
          metadataRemoved: metadata === "strip",
          stamped: true,
        },
      }),
  );

  const body = new ArrayBuffer(renditionBytes.byteLength);
  new Uint8Array(body).set(renditionBytes);

  return secureDocumentResponse({
    body,
    contentLength: body.byteLength,
    contentType: content.mimeType,
    disposition: "attachment",
    fileName: sanitizeFilename(content.fileName),
  });
};
