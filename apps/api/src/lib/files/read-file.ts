import { panic, Result } from "better-result";

import {
  buildVersionedApiUrl,
  PREVIEW_UNAVAILABLE_ERROR_CODE,
} from "@stll/api-contract";
import {
  type FilePart,
  filePartInlineBytes,
} from "@stll/api-contract/file-parts";
import {
  type UnscannedContentReason,
  unscannedContentReasons,
} from "@stll/api-contract/file-scan-warnings";
import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db-types";
import type { entities, entityVersions, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import { status } from "@/api/http/status";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  CONTENT_DELIVERY_AUDIT_ACTION,
  type ContentDisposition,
} from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { isStampableDocx } from "@/api/lib/docx-stamp";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { markContentDeliveryIntent } from "@/api/lib/files/content-delivery";
import {
  createFileContentGrant,
  type FileContentPurpose,
} from "@/api/lib/files/file-content-grant";
import { type FilePartRead, readFilePart } from "@/api/lib/files/file-part";
import {
  filePartDisplayIdentity,
  filePartForDisplay,
} from "@/api/lib/files/file-part-rendition";
import { isNativelyRenderableMimeType } from "@/api/lib/files/gotenberg";
import { lockLiveVersionField } from "@/api/lib/files/live-version-field";
import { openWithinDeadline } from "@/api/lib/files/storage-open-deadline";
import { createFileKey } from "@/api/lib/files/utils";
import { failureSink } from "@/api/lib/observability/failure";
import { observedStatus } from "@/api/lib/observability/server-error-answer";
import { openS3ObjectStreamWithSignal } from "@/api/lib/s3";
import type { SignedDownloadSource } from "@/api/lib/s3-presign";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { issueSessionBoundCredentialTtl } from "@/api/lib/synthetic-principal/credential-policy";
import type { SyntheticSessionAuthorityReader } from "@/api/lib/synthetic-principal/session-authority";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const STORED_FILE_CONTENT_UNREADABLE = failureSink({
  event: "files.content_grant_unreadable",
  expected: [],
});

export const FILE_READ_URL_EXPIRY_SECONDS = 15 * 60;
const FILE_READ_STORAGE_TIMEOUT_MS = 30_000;
const refuseBackgroundSessionAuthority: SyntheticSessionAuthorityReader =
  async () => await Promise.resolve(null);

const previewUnavailable = () =>
  status(400, {
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message: "This file has no preview. Download it instead.",
  });

type ReadFileHandlerProps = {
  source: SignedDownloadSource;
  scopedDb: ScopedDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  purpose: FileContentPurpose;
  recordAuditEvent: AuditRecorder;
  readSessionAuthority: SyntheticSessionAuthorityReader;
};

/** What a delivery reads from a live version's file field. */
type FileFieldRow = {
  content: (typeof fields.$inferSelect)["content"];
  entityId: (typeof entities.$inferSelect)["id"];
  verificationCode: (typeof entityVersions.$inferSelect)["verificationCode"];
  versionStamp: (typeof entityVersions.$inferSelect)["stamp"];
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

type FileDelivery = {
  disposition: ContentDisposition;
  encrypted: boolean;
  /** Why some of the stored file's content was not scanned; empty when all was. */
  unscannedContent: UnscannedContentReason[];
  entityId: SafeId<"entity">;
  fileId: string;
  fileName: string;
  mimeType: string;
  originalMimeType: string;
  s3Key: string;
  sizeBytes?: number;
  stampable: boolean;
};

type FileDeliveryResolution =
  | { type: "found"; delivery: FileDelivery }
  | { type: "invalid" | "not-found" | "preview-unavailable" };

const resolveFileDelivery = ({
  organizationId,
  purpose,
  row,
  workspaceId,
}: {
  organizationId: SafeId<"organization">;
  purpose: FileContentPurpose;
  row: FileFieldRow | undefined;
  workspaceId: SafeId<"workspace">;
}): FileDeliveryResolution => {
  if (!row) {
    return { type: "not-found" };
  }
  if (row.content.type !== "file") {
    return { type: "invalid" };
  }

  const content = row.content;
  const unscannedContent = unscannedContentReasons(content.scanWarnings);
  const originalKey = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  if (purpose === "download") {
    return {
      type: "found",
      delivery: {
        disposition: "attachment",
        encrypted: content.encrypted,
        unscannedContent,
        entityId: row.entityId,
        fileId: content.id,
        fileName: content.fileName,
        mimeType: content.mimeType,
        originalMimeType: content.mimeType,
        s3Key: originalKey,
        sizeBytes: content.sizeBytes,
        stampable:
          !!row.versionStamp &&
          !!row.verificationCode &&
          isStampableDocx(content.mimeType, content.sizeBytes) &&
          !content.encrypted,
      },
    };
  }

  if (
    purpose === "native-display" &&
    !isNativelyRenderableMimeType(content.mimeType)
  ) {
    return { type: "preview-unavailable" };
  }
  if (
    purpose === "native-display" ||
    isNativelyRenderableMimeType(content.mimeType)
  ) {
    return {
      type: "found",
      delivery: {
        disposition: "inline",
        encrypted: content.encrypted,
        unscannedContent,
        entityId: row.entityId,
        fileId: content.id,
        fileName: content.fileName,
        mimeType: content.mimeType,
        originalMimeType: content.mimeType,
        s3Key: originalKey,
        sizeBytes: content.sizeBytes,
        stampable: false,
      },
    };
  }

  const displayFileId = displayedPdfFileId(content);
  if (displayFileId === null) {
    return { type: "preview-unavailable" };
  }
  return {
    type: "found",
    delivery: {
      disposition: "inline",
      encrypted: content.encrypted,
      unscannedContent,
      entityId: row.entityId,
      fileId: displayFileId,
      fileName: content.fileName,
      mimeType: PDF_MIME_TYPE,
      originalMimeType: content.mimeType,
      s3Key: createFileKey({
        organizationId,
        workspaceId,
        fileId: displayFileId,
        mimeType: PDF_MIME_TYPE,
      }),
      stampable: false,
    },
  };
};

const fileContentGrantUrl = (grant: string): string =>
  buildVersionedApiUrl(
    env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
    `/file-content/${encodeURIComponent(grant)}`,
  );

/**
 * Issue a grant for a matter file's bytes for `purpose`. The lookup, the audit
 * row and the grant share one transaction that holds the version's share
 * lock, so a tombstone either commits before the lookup (404) or waits until
 * the grant is issued and audited. Redeeming the grant checks liveness again.
 */
export const readFileHandler = async ({
  scopedDb,
  source,
  fieldId,
  organizationId,
  workspaceId,
  userId,
  purpose,
  recordAuditEvent,
  readSessionAuthority,
}: ReadFileHandlerProps) =>
  await scopedDb(async (tx) => {
    const row = await lockLiveVersionField(tx, fieldId, workspaceId);
    const resolution = resolveFileDelivery({
      organizationId,
      purpose,
      row: row ?? undefined,
      workspaceId,
    });
    switch (resolution.type) {
      case "found":
        break;
      case "not-found":
        return status(404);
      case "preview-unavailable":
        return previewUnavailable();
      case "invalid":
        return status(400);
      default:
        resolution satisfies never;
        return panic("Unhandled file delivery resolution");
    }

    const delivery: FileDelivery = resolution.delivery;
    const now = Temporal.Now.instant().epochMilliseconds;
    const expiresIn = await issueSessionBoundCredentialTtl("signedDownload", {
      userId,
      organizationId,
      fileOrganizationId: organizationId,
      requestedTtlSeconds: FILE_READ_URL_EXPIRY_SECONDS,
      now: new Date(now),
      sessionId: source.kind === "request" ? source.sessionId : null,
      readSessionAuthority:
        source.kind === "request"
          ? readSessionAuthority
          : refuseBackgroundSessionAuthority,
    });
    await recordAuditEvent(tx, {
      action: CONTENT_DELIVERY_AUDIT_ACTION[delivery.disposition],
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: delivery.entityId,
      metadata: {
        disposition: delivery.disposition,
        fieldId,
        mimeType: delivery.mimeType,
        purpose,
        s3Key: delivery.s3Key,
        ...(delivery.disposition === "attachment"
          ? { fileName: delivery.fileName }
          : {}),
        ...(delivery.sizeBytes === undefined
          ? {}
          : { sizeBytes: delivery.sizeBytes }),
      },
    });
    const grant = createFileContentGrant({
      expiresAt: now + expiresIn * 1000,
      fieldId,
      now,
      organizationId,
      purpose,
      secret: env.BETTER_AUTH_SECRET,
      userId,
      workspaceId,
    });
    markContentDeliveryIntent();
    return {
      kind: "file" as const,
      fileId: delivery.fileId,
      mimeType: delivery.mimeType,
      originalMimeType: delivery.originalMimeType,
      fileName: delivery.fileName,
      encrypted: delivery.encrypted,
      unscannedContent: delivery.unscannedContent,
      // Kept for client compatibility; this is now a Stella grant URL whose
      // redemption rechecks version liveness, rather than a direct S3 URL.
      presignedUrl: fileContentGrantUrl(grant),
      stampable: delivery.stampable,
    };
  });

/** A part is delivered inline for display, as an attachment for download. */
const partDisposition = (purpose: FileContentPurpose) =>
  purpose === "download" ? "attachment" : "inline";

/**
 * Issue a grant for one part of a matter file: an attachment, a signed
 * envelope's document, a container's member. The part is read and scanned
 * now, and its delivery recorded while the version is share-locked; the grant
 * reads it again, under the same liveness check, when it is redeemed.
 */
export const readFilePartUrlHandler = async ({
  part,
  scopedDb,
  source,
  fieldId,
  organizationId,
  workspaceId,
  userId,
  purpose,
  recordAuditEvent,
  readSessionAuthority,
}: ReadFileHandlerProps & { part: FilePart }): Promise<
  Result<
    {
      kind: "part";
      fileName: string;
      mimeType: string;
      originalMimeType: string;
      presignedUrl: string;
      stampable: false;
    },
    HandlerError
  >
> => {
  const read = await readFilePart({
    scopedDb,
    workspaceId,
    organizationId,
    fieldId,
    recordAuditEvent,
    part,
    disposition: partDisposition(purpose),
  });
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const now = Temporal.Now.instant().epochMilliseconds;
  const expiresIn = await issueSessionBoundCredentialTtl("signedDownload", {
    userId,
    organizationId,
    fileOrganizationId: organizationId,
    requestedTtlSeconds: FILE_READ_URL_EXPIRY_SECONDS,
    now: new Date(now),
    sessionId: source.kind === "request" ? source.sessionId : null,
    readSessionAuthority:
      source.kind === "request"
        ? readSessionAuthority
        : refuseBackgroundSessionAuthority,
  });
  const grant = createFileContentGrant({
    expiresAt: now + expiresIn * 1000,
    fieldId,
    now,
    organizationId,
    part,
    purpose,
    secret: env.BETTER_AUTH_SECRET,
    userId,
    workspaceId,
  });
  markContentDeliveryIntent();
  // A display names what the grant delivers: a converted type's PDF.
  const delivered =
    partDisposition(purpose) === "inline"
      ? filePartDisplayIdentity(read.value)
      : read.value;
  return Result.ok({
    kind: "part",
    fileName: delivered.fileName,
    mimeType: delivered.mimeType,
    originalMimeType: read.value.mimeType,
    presignedUrl: fileContentGrantUrl(grant),
    stampable: false,
  });
};

/** The grant's issuance recorded the part's delivery. */
const deliveryRecordedAtIssuance: AuditRecorder = async () => {
  await Promise.resolve();
};

/** Redeems a part grant: the part read again, under the liveness check. */
export const readFilePartContentHandler = async ({
  fieldId,
  organizationId,
  part,
  purpose,
  scopedDb,
  workspaceId,
}: Omit<ReadFileContentHandlerProps, "abortSignal"> & { part: FilePart }) => {
  const read = await readFilePart({
    scopedDb,
    workspaceId,
    organizationId,
    fieldId,
    recordAuditEvent: deliveryRecordedAtIssuance,
    part,
    disposition: partDisposition(purpose),
  });
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const disposition = partDisposition(purpose);
  // A display shows a converted document as its PDF and a text part's head
  // only; a download is always the whole part.
  const shown =
    disposition === "inline"
      ? await filePartForDisplay(read.value)
      : Result.ok<FilePartRead, HandlerError>(read.value);
  if (shown.isErr()) {
    return Result.err(shown.error);
  }
  const { bytes, fileName, mimeType } = shown.value;
  const body =
    disposition === "inline" ? filePartInlineBytes(bytes, mimeType) : bytes;
  return Result.ok(
    secureDocumentResponse({
      body,
      contentLength: body.byteLength,
      contentType: mimeType,
      disposition,
      fileName: sanitizeFilename(fileName),
    }),
  );
};

type ReadFileContentHandlerProps = {
  abortSignal: AbortSignal;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  purpose: FileContentPurpose;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readFileContentHandler = async ({
  abortSignal,
  fieldId,
  organizationId,
  purpose,
  scopedDb,
  workspaceId,
}: ReadFileContentHandlerProps) => {
  const result = await scopedDb(async (tx) => {
    // The version stays share-locked until object storage has accepted the
    // GET: a tombstone waits, and one that committed first leaves no row.
    const row = await lockLiveVersionField(tx, fieldId, workspaceId);
    const resolution = resolveFileDelivery({
      organizationId,
      purpose,
      row: row ?? undefined,
      workspaceId,
    });
    if (resolution.type !== "found") {
      return resolution;
    }
    const { delivery } = resolution;
    // The deadline bounds the open; the body then streams for as long as
    // the client keeps reading, and stops when it disconnects.
    const opened = await Result.tryPromise(
      async () =>
        await openWithinDeadline({
          open: async (signal) =>
            await openS3ObjectStreamWithSignal(delivery.s3Key, signal),
          signal: abortSignal,
          timeoutMs: FILE_READ_STORAGE_TIMEOUT_MS,
        }),
    );
    if (Result.isError(opened)) {
      abortSignal.throwIfAborted();
      return { type: "storage-failure" as const, cause: opened.error };
    }
    return { type: "response" as const, delivery, source: opened.value };
  });

  switch (result.type) {
    case "invalid":
      return status(400);
    case "preview-unavailable":
      return previewUnavailable();
    case "not-found":
      return status(404);
    case "storage-failure":
      return observedStatus(
        { sink: STORED_FILE_CONTENT_UNREADABLE, cause: result.cause },
        502,
        "Bad Gateway",
      );
    case "response": {
      return secureDocumentResponse({
        body: result.source.body,
        ...(result.source.contentLength === undefined
          ? {}
          : { contentLength: result.source.contentLength }),
        contentType: result.delivery.mimeType,
        disposition: result.delivery.disposition,
        fileName: sanitizeFilename(result.delivery.fileName),
      });
    }
    default:
      result satisfies never;
      return panic("Unhandled file content delivery result");
  }
};
