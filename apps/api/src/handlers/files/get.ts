import { Result } from "better-result";

import { DOCUMENT_PROPERTIES_MAX_BYTES } from "@stll/api-contract";
import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";
import { classifyFailure } from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";

import type { ScopedDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { status } from "@/api/http/status";
import { captureError } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { CONTENT_DELIVERY_AUDIT_ACTION } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { DocxArchiveError } from "@/api/lib/docx-archive";
import { injectStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import { scrubDocumentProperties } from "@/api/lib/files/document-properties";
import { createEmailAttachmentDescriptor } from "@/api/lib/files/email-attachment-token";
import { emailToPreview } from "@/api/lib/files/email-to-html";
import { convertToPdf, isConvertibleMimeType } from "@/api/lib/files/gotenberg";
import {
  FILE_READ_URL_EXPIRY_SECONDS,
  fileFieldQuery,
} from "@/api/lib/files/read-file";
import { createFileKey } from "@/api/lib/files/utils";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { observedStatus } from "@/api/lib/observability/server-error-answer";
import { getS3 } from "@/api/lib/s3";
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
  recordAuditEvent: AuditRecorder;
};

export const readEmailHtmlPreviewHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
  recordAuditEvent,
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
  const fileBuffer = (
    await readStoredFile({ key: fileKey, mimeType: content.mimeType })
  ).bytes;
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
    captureError(
      previewResult.error,
      handlerErrorContext(
        "files.readEmailHtmlPreviewHandler.previewResult_error",
        {
          fieldId,
          mimeType: emailMimeType,
          workspaceId,
        },
      ),
    );
    return status(422, { message: "Failed to render email preview" });
  }

  // The preview carries the message body; record the view once there is a
  // preview to return.
  await scopedDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: CONTENT_DELIVERY_AUDIT_ACTION.inline,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: row.entityId,
        workspaceId,
        metadata: {
          disposition: "inline",
          fieldId,
          format: "email-html",
          mimeType: content.mimeType,
          sizeBytes: content.sizeBytes,
        },
      }),
  );

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

const stampedDownloadUnreadable = failureSink({
  event: "files.stamped_download_unreadable",
  expected: [],
});

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

const STORED_FILE_UNREADABLE = failureSink({
  event: "files.stored_file_unreadable",
  expected: [],
});

const PDF_CONVERSION_FAILED = failureSink({
  event: "files.pdf_conversion_failed",
  expected: [],
});

/** The store answered, but not with the file. */
const storedFileUnavailable = (storeStatus: number) =>
  new HandlerError({
    status: 502,
    code: "upstream_unavailable",
    message: `File storage answered ${String(storeStatus)}`,
  });

/** The 502 a download answers when the stored file cannot be read. */
const storedFileUnreadable = (cause: unknown) =>
  observedStatus({ sink: STORED_FILE_UNREADABLE, cause }, 502, "Bad Gateway");

/** A stored file's response, or the rejection or store answer that kept it. */
const fetchStoredFileResponse = async (
  key: string,
): Promise<Result<Response, unknown>> => {
  const response = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(
        getS3().presign(key, { expiresIn: FILE_READ_URL_EXPIRY_SECONDS }),
        { timeoutMs: 30_000 },
      ),
  );
  if (Result.isError(response)) {
    return Result.err(response.error);
  }
  return response.value.ok
    ? Result.ok(response.value)
    : Result.err(storedFileUnavailable(response.value.status));
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

    if (Result.isError(response)) {
      return storedFileUnreadable(response.error);
    }

    await recordDownload();
    return streamedPdfResponse(response.value, outputName);
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
    return storedFileUnreadable(source.error);
  }

  const conversionResult = await convertToPdf(source.value);

  if (Result.isError(conversionResult)) {
    return observedStatus(
      {
        sink: PDF_CONVERSION_FAILED,
        cause: conversionResult.error,
        ctx: { workspaceId },
      },
      502,
      "Bad Gateway",
    );
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
    return storedFileUnreadable(storedFileUnavailable(response.status));
  }

  const buffer = await response.arrayBuffer();
  const versionStamp = row.versionStamp;
  const verificationCode = row.verificationCode;
  const stampResult = await Result.tryPromise({
    try: async () =>
      await injectStamp(
        buffer,
        versionStamp,
        verificationCode,
        env.FRONTEND_URL,
      ),
    catch: (cause): Error =>
      cause instanceof Error
        ? cause
        : new Error("Stamp injection failed", { cause }),
  });
  if (Result.isError(stampResult)) {
    if (stampResult.error instanceof DocxArchiveError) {
      // The stored bytes are not a DOCX archive this path can read, so no
      // stamped rendition exists; answer as the metadata scrub below does.
      // The archive is the user's own upload, so this boundary classifies the
      // failure as a request the stored document cannot serve.
      observeFailure(classifyFailure(stampResult.error, "request_invalid"), {
        sink: stampedDownloadUnreadable,
        ctx: {
          phase: stampResult.error.reason,
          step: "stampedDownloadHandler.injectStamp",
        },
      });
      return status(422);
    }
    return await Promise.reject(stampResult.error);
  }
  const stamped = stampResult.value;
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
