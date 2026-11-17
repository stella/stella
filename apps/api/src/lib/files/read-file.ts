import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { status } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { isStampableDocx } from "@/api/lib/docx-stamp";
import { isNativelyRenderableMimeType } from "@/api/lib/files/gotenberg";
import { lockLiveVersionField } from "@/api/lib/files/live-version-field";
import { createFileKey } from "@/api/lib/files/utils";
import type { SignedDownloadSource } from "@/api/lib/s3-presign";
import type { SyntheticSessionAuthorityReader } from "@/api/lib/synthetic-principal/session-authority";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export const FILE_READ_URL_EXPIRY_SECONDS = 15 * 60;

const previewUnavailable = () =>
  status(400, {
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message: "This file has no preview. Download it instead.",
  });

type FilePurpose = "download" | "display" | "native-display";

type ReadFileHandlerProps = {
  userId: SafeId<"user">;
  source: SignedDownloadSource;
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  purpose: FilePurpose;
  recordAuditEvent: AuditRecorder;
  readSessionAuthority: SyntheticSessionAuthorityReader;
};

type DisplayedFileContent = {
  id: string;
  mimeType: string;
  pdfFileId: string | null;
};

/**
 * The PDF the viewer shows for a file field: its PDF rendition, else the
 * file itself when it is a PDF. Null when the viewer renders the file
 * natively, or there is no PDF to show. Anything anchored to what the
 * reader saw (a mark's page text) reads these bytes.
 */
export const displayedPdfFileId = (
  content: DisplayedFileContent,
): string | null => {
  if (isNativelyRenderableMimeType(content.mimeType)) {
    return null;
  }
  return (
    content.pdfFileId ??
    (content.mimeType === PDF_MIME_TYPE ? content.id : null)
  );
};

/**
 * Sign a link to a matter file's bytes for `purpose`. The lookup, the audit
 * row and the signature share one transaction that holds the version's share
 * lock, so a tombstone either commits before the lookup (404) or waits until
 * the link is signed and audited.
 */
export const readFileHandler = async ({
  scopedDb,
  userId,
  source,
  fieldId,
  organizationId,
  workspaceId,
  purpose,
  recordAuditEvent,
  readSessionAuthority,
}: ReadFileHandlerProps) =>
  await scopedDb(async (tx) => {
    const row = await lockLiveVersionField(tx, fieldId, workspaceId);

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

    // Every purpose grants the stored bytes through the audited helper;
    // `purpose` and the delivered object identify what the caller received.
    const grantUrl = async ({
      s3Key,
      fileName,
      mimeType,
      sizeBytes,
    }: {
      s3Key: string;
      fileName?: string;
      mimeType: string;
      // Known for the stored original only, not for a derived rendition.
      sizeBytes?: number;
    }) =>
      await auditedPresignDownload({
        readSessionAuthority,
        versionLock: row.lock,
        recordAuditEvent,
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        userId,
        source,
        s3Key,
        expiresInSeconds: FILE_READ_URL_EXPIRY_SECONDS,
        ...(fileName === undefined ? {} : { fileName }),
        organizationId,
        workspaceId,
        metadata: {
          fieldId,
          purpose,
          mimeType,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        },
      });

    if (purpose === "download") {
      return {
        fileId: content.id,
        mimeType: content.mimeType,
        originalMimeType: content.mimeType,
        fileName: content.fileName,
        encrypted: content.encrypted,
        presignedUrl: await grantUrl({
          s3Key: fileKey,
          fileName: content.fileName,
          mimeType: content.mimeType,
          sizeBytes: content.sizeBytes,
        }),
        stampable:
          !!row.versionStamp &&
          !!row.verificationCode &&
          isStampableDocx(content.mimeType, content.sizeBytes) &&
          !content.encrypted,
      };
    }

    if (
      purpose === "native-display" &&
      !isNativelyRenderableMimeType(content.mimeType)
    ) {
      return previewUnavailable();
    }

    if (
      purpose === "native-display" ||
      isNativelyRenderableMimeType(content.mimeType)
    ) {
      return {
        fileId: content.id,
        mimeType: content.mimeType,
        originalMimeType: content.mimeType,
        fileName: content.fileName,
        encrypted: content.encrypted,
        presignedUrl: await grantUrl({
          s3Key: fileKey,
          mimeType: content.mimeType,
          sizeBytes: content.sizeBytes,
        }),
        stampable: false,
      };
    }

    const displayFileId = displayedPdfFileId(content);
    if (displayFileId === null) {
      return previewUnavailable();
    }
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
      presignedUrl: await grantUrl({
        s3Key: displayFileKey,
        mimeType: PDF_MIME_TYPE,
      }),
      stampable: false,
    };
  });
