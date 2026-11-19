import { Result } from "better-result";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { legalFileFormat } from "@stll/api-contract/document-format";
import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import { BodyByteLimitError } from "@stll/fetch/body-reader";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { HTTP_FAILURE } from "@/api/http/errors";
import { AUDIT_RESOURCE_TYPE, type AuditRecorder } from "@/api/lib/audit-log";
import { CONTENT_DELIVERY_AUDIT_ACTION } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import {
  DOCUMENT_ARCHIVE_MAX_BYTES,
  isDocumentArchiveMimeType,
} from "@/api/lib/files/archive-preview-protocol";
import {
  fileFieldQuery,
  lockLiveVersionField,
} from "@/api/lib/files/live-version-field";
import { createFileKey } from "@/api/lib/files/utils";
import { S3ObjectBudgetError } from "@/api/lib/s3";

export type LegalFileReadOptions = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  fieldId: SafeId<"field">;
  recordAuditEvent: AuditRecorder;
  purpose?: "preview" | "agent" | "standalone";
};

const missingFile = () =>
  Result.err(
    new HandlerError({
      status: 404,
      code: HTTP_FAILURE.notFound,
      message: "File not found",
    }),
  );

const archiveTooLarge = () =>
  Result.err(
    new HandlerError({
      status: 422,
      code: PREVIEW_UNAVAILABLE_ERROR_CODE,
      message: "The archive exceeds the preview size limit",
    }),
  );

export const legalSourceChanged = () =>
  Result.err(
    new HandlerError({
      status: 409,
      code: "source_changed",
      message: "The source changed during this read. Read the file again.",
      retryable: true,
      retryAfterMs: 0,
    }),
  );

export const loadLegalFileSource = async (
  {
    scopedDb,
    workspaceId,
    organizationId,
    fieldId,
    recordAuditEvent,
    purpose = "preview",
  }: LegalFileReadOptions,
  acceptedKinds: readonly LegalFileFormatKind[],
) => {
  const [row] = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  if (row?.content.type !== "file") {
    return missingFile();
  }
  const { content, entityId } = row;
  const format = legalFileFormat(content.mimeType, content.fileName);
  if (content.encrypted || !format || !acceptedKinds.includes(format.kind)) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: PREVIEW_UNAVAILABLE_ERROR_CODE,
        message: "Preview unavailable for this file",
      }),
    );
  }
  const isArchive = isDocumentArchiveMimeType(format.mimeType);
  if (isArchive && content.sizeBytes > DOCUMENT_ARCHIVE_MAX_BYTES) {
    return archiveTooLarge();
  }

  const key = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  const source = await readStoredFile({
    key,
    mimeType: content.mimeType,
    fileName: content.fileName,
    ...(isArchive ? { maxBytes: DOCUMENT_ARCHIVE_MAX_BYTES } : {}),
  }).then(
    (file) => Result.ok(file),
    (error: unknown) =>
      isArchive &&
      (S3ObjectBudgetError.is(error) || BodyByteLimitError.is(error))
        ? archiveTooLarge()
        : Promise.reject(error),
  );
  if (source.isErr()) {
    return Result.err(source.error);
  }

  // Parse outside the transaction. Only release a result while the same live
  // source is share-locked, after its delivery has been recorded.
  const deliver = async <T extends Result<unknown, HandlerError>>(
    prepare: (tx: Transaction) => Promise<T> | T,
  ) =>
    await scopedDb(async (tx) => {
      const live = await lockLiveVersionField(tx, fieldId, workspaceId);
      if (
        live?.content.type !== "file" ||
        live.entityId !== entityId ||
        live.content.id !== content.id ||
        live.content.encrypted
      ) {
        return missingFile();
      }
      if (
        live.content.mimeType !== content.mimeType ||
        live.content.fileName !== content.fileName ||
        live.content.sha256Hex !== content.sha256Hex ||
        (purpose !== "preview" && live.versionId !== live.currentVersionId)
      ) {
        return legalSourceChanged();
      }
      const prepared = await prepare(tx);
      if (prepared.isOk()) {
        await recordAuditEvent(tx, {
          action: CONTENT_DELIVERY_AUDIT_ACTION.inline,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entityId,
          workspaceId,
          metadata: {
            disposition: "inline",
            fieldId,
            format: format.auditFormat,
            mimeType: content.mimeType,
            sizeBytes: content.sizeBytes,
          },
        });
      }
      return prepared;
    });
  return Result.ok({
    source: source.value,
    mimeType: format.mimeType,
    entityId,
    deliver,
  });
};
