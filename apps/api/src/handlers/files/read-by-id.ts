import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  emailToHtml,
  resolveEmailMimeType,
} from "@/api/handlers/files/email-to-html";
import {
  convertToPdf,
  isConvertibleMimeType,
  isNativelyRenderableMimeType,
} from "@/api/handlers/files/gotenberg";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { injectStamp, isStampableDocx } from "@/api/lib/docx-stamp";
import { getS3 } from "@/api/lib/s3";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type FilePurpose = "download" | "display" | "native-display";

type ReadFileHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  purpose: FilePurpose;
  recordAuditEvent: AuditRecorder;
};

const BASE_URL = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

const fileFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
        entityId: entities.id,
        versionStamp: entityVersions.stamp,
        verificationCode: entityVersions.verificationCode,
      })
      .from(fields)
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.entityId, entities.id),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .where(eq(fields.id, fieldId))
      .limit(1),
  );

export const readFileHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
  purpose,
  recordAuditEvent,
}: ReadFileHandlerProps) => {
  const rows = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  const row = rows.at(0);

  if (!row) {
    return status(404);
  }

  if (row.content.type !== "file") {
    return status(400);
  }

  const content = row.content;
  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });

  if (purpose === "download") {
    const presignedUrl = await scopedDb(
      async (tx) =>
        await auditedPresignDownload({
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: row.entityId,
          s3Key: fileKey,
          expiresInSeconds: 900,
          fileName: content.fileName,
          organizationId,
          workspaceId,
          metadata: {
            fieldId,
            mimeType: content.mimeType,
            sizeBytes: content.sizeBytes,
          },
        }),
    );

    return {
      fileId: content.id,
      mimeType: content.mimeType,
      originalMimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl,
      stampable:
        !!row.versionStamp &&
        !!row.verificationCode &&
        isStampableDocx(content.mimeType, content.sizeBytes) &&
        !content.encrypted,
    };
  }

  if (purpose === "native-display") {
    if (!isNativelyRenderableMimeType(content.mimeType)) {
      return status(400);
    }

    const nativeFileKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: content.id,
      mimeType: content.mimeType,
    });

    return {
      fileId: content.id,
      mimeType: content.mimeType,
      originalMimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl: await presignDownloadUrl(nativeFileKey, {
        expiresIn: 900,
        scope: { organizationId, workspaceId },
      }),
      stampable: false,
    };
  }

  // Natively-renderable types (DOCX) serve their original bytes
  // for display — the frontend renders them via Folio, never via
  // Gotenberg. PDFs serve themselves. Anything else needs a
  // PDF derivative on the field.
  if (isNativelyRenderableMimeType(content.mimeType)) {
    const nativeFileKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: content.id,
      mimeType: content.mimeType,
    });

    return {
      fileId: content.id,
      mimeType: content.mimeType,
      originalMimeType: content.mimeType,
      fileName: content.fileName,
      encrypted: content.encrypted,
      presignedUrl: await presignDownloadUrl(nativeFileKey, {
        expiresIn: 900,
        scope: { organizationId, workspaceId },
      }),
      stampable: false,
    };
  }

  if (!content.pdfFileId && content.mimeType !== PDF_MIME_TYPE) {
    return status(400);
  }

  const displayFileId = content.pdfFileId ?? content.id;

  const displayFileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: displayFileId,
    mimeType: PDF_MIME_TYPE,
  });

  return {
    fileId: displayFileId,
    mimeType: PDF_MIME_TYPE,
    originalMimeType: content.mimeType,
    fileName: content.fileName,
    encrypted: content.encrypted,
    presignedUrl: await presignDownloadUrl(displayFileKey, {
      expiresIn: 900,
      scope: { organizationId, workspaceId },
    }),
    stampable: false,
  };
};

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
  const fileBuffer = await getS3().file(fileKey).arrayBuffer();
  const htmlResult = await emailToHtml(fileBuffer, emailMimeType);

  if (Result.isError(htmlResult)) {
    captureError(htmlResult.error, {
      fieldId,
      mimeType: emailMimeType,
      workspaceId,
    });
    return status(422, { message: "Failed to render email preview" });
  }

  return {
    fileId: content.id,
    fileName: content.fileName,
    html: htmlResult.value,
    mimeType: "text/html",
    originalMimeType: emailMimeType,
  };
};

// ── Stamped download (separate endpoint) ────────────────

type StampedDownloadHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

type PrintPdfHandlerProps = {
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

const pdfFileName = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${fileName}.pdf`;
  }
  return `${fileName.slice(0, dotIndex)}.pdf`;
};

const inlineContentDisposition = (fileName: string): string =>
  contentDisposition(fileName).replace(/^attachment;/u, "inline;");

const fetchStoredFileResponse = async (
  key: string,
): Promise<Response | null> => {
  const response = await fetch(getS3().presign(key, { expiresIn: 900 }), {
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response;
};

const fetchStoredFile = async (key: string): Promise<ArrayBuffer | null> => {
  const response = await fetchStoredFileResponse(key);

  if (!response) {
    return null;
  }

  return await response.arrayBuffer();
};

const pdfResponse = (buffer: ArrayBuffer, fileName: string) =>
  new Response(buffer, {
    headers: {
      "Content-Type": PDF_MIME_TYPE,
      "Content-Disposition": inlineContentDisposition(fileName),
      "Content-Length": String(buffer.byteLength),
    },
  });

const streamedPdfResponse = (response: Response, fileName: string) =>
  new Response(response.body, {
    headers: {
      "Content-Type": PDF_MIME_TYPE,
      "Content-Disposition": inlineContentDisposition(fileName),
      ...(response.headers.has("Content-Length")
        ? { "Content-Length": response.headers.get("Content-Length") ?? "" }
        : {}),
    },
  });

export const printPdfHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
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
  const sourceBuffer = await fetchStoredFile(sourceKey);

  if (!sourceBuffer) {
    return status(502);
  }

  const conversionResult = await convertToPdf(
    sourceBuffer,
    content.fileName,
    content.mimeType,
  );

  if (Result.isError(conversionResult)) {
    captureError(conversionResult.error, {
      fieldId,
      mimeType: content.mimeType,
      sizeBytes: String(content.sizeBytes),
    });
    return status(502);
  }

  return pdfResponse(conversionResult.value.buffer, outputName);
};

/**
 * Download a DOCX with Stella stamps injected. Returns the
 * modified file as a streamed `Response`. Only called when
 * the user explicitly requests stamping via a dedicated
 * action (right-click → "Download with stamp").
 */
export const stampedDownloadHandler = async ({
  scopedDb,
  fieldId,
  organizationId,
  workspaceId,
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
    content.encrypted
  ) {
    return status(400);
  }

  const fileKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });

  const presignedUrl = getS3().presign(fileKey, { expiresIn: 900 });
  const response = await fetch(presignedUrl, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    return status(502);
  }

  const buffer = await response.arrayBuffer();
  const stamped = await injectStamp(
    buffer,
    row.versionStamp,
    row.verificationCode,
    BASE_URL,
  );

  return new Response(stamped, {
    headers: {
      "Content-Type": content.mimeType,
      "Content-Disposition": contentDisposition(content.fileName),
      "Content-Length": String(stamped.byteLength),
    },
  });
};
