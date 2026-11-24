import { Result, UnhandledException } from "better-result";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import {
  legalFileFormat,
  signatureFormatCandidate,
} from "@stll/api-contract/document-format";
import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import { BodyByteLimitError } from "@stll/fetch/body-reader";

import type { ScopedDb } from "@/api/db/safe-db-types";
import type { Transaction } from "@/api/db/types";
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
import { zipNameCodePageSource } from "@/api/lib/files/organization-zip-name-code-page";
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

/** How a stored file is read: the type it is read as and its read budget. */
export type FileSourceFormat = {
  readonly mimeType: string;
  readonly auditFormat: string;
  /** The stored file's byte budget; a larger file is not read. */
  readonly maxBytes?: number | undefined;
};

type StoredFileContent = {
  readonly mimeType: string;
  readonly fileName: string;
  readonly sizeBytes: number;
};

const legalSourceFormat =
  (acceptedKinds: readonly LegalFileFormatKind[]) =>
  (content: StoredFileContent) => {
    // A `.sig` or `.xml` file reaches a signature reader as a candidate: its
    // reader decides from the bytes, and only a reader that accepts the kind.
    // A reader of the registered kind (`.xml` as XML) reads it as that.
    const registered = legalFileFormat(content.mimeType, content.fileName);
    const candidate =
      registered !== undefined && acceptedKinds.includes(registered.kind)
        ? undefined
        : signatureFormatCandidate(content.mimeType, content.fileName);
    const format = candidate ?? registered;
    if (!format || !acceptedKinds.includes(format.kind)) {
      return null;
    }
    return {
      kind: format.kind,
      /** The name alone does not make the file this format. */
      sniffed: candidate !== undefined,
      mimeType: format.mimeType,
      auditFormat: format.auditFormat,
      ...(isDocumentArchiveMimeType(format.mimeType)
        ? { maxBytes: DOCUMENT_ARCHIVE_MAX_BYTES }
        : {}),
    };
  };

/** A legal file of one of `acceptedKinds`, found but not read; see below. */
export const openLegalFileSource = async (
  options: LegalFileReadOptions,
  acceptedKinds: readonly LegalFileFormatKind[],
) => await openFileSource(options, legalSourceFormat(acceptedKinds));

export const loadLegalFileSource = async (
  options: LegalFileReadOptions,
  acceptedKinds: readonly LegalFileFormatKind[],
) => await loadFileSource(options, legalSourceFormat(acceptedKinds));

/**
 * Finds a stored file that `accept` recognizes without reading it, and hands
 * back its key, `load`, which reads it whole within its format's budget, and
 * `deliver`, which releases a result only while the same live version is
 * share-locked and after its delivery has been recorded. A file read another
 * way (a mailbox streamed one message at a time) never calls `load`.
 */
export const openFileSource = async <TFormat extends FileSourceFormat>(
  {
    scopedDb,
    workspaceId,
    organizationId,
    fieldId,
    recordAuditEvent,
    purpose = "preview",
  }: LegalFileReadOptions,
  accept: (content: StoredFileContent) => TFormat | null,
) => {
  const [row] = await fileFieldQuery(scopedDb, fieldId, workspaceId);
  if (row?.content.type !== "file") {
    return missingFile();
  }
  const { content, entityId } = row;
  const format = content.encrypted ? null : accept(content);
  if (format === null) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: PREVIEW_UNAVAILABLE_ERROR_CODE,
        message: "Preview unavailable for this file",
      }),
    );
  }
  const { maxBytes } = format;
  const isArchive = maxBytes !== undefined;
  if (isArchive && content.sizeBytes > maxBytes) {
    return archiveTooLarge();
  }

  const key = createFileKey({
    organizationId,
    workspaceId,
    fileId: content.id,
    mimeType: content.mimeType,
  });
  const load = async () =>
    await readStoredFile({
      key,
      mimeType: content.mimeType,
      fileName: content.fileName,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }).then(
      (file) => Result.ok(file),
      async (error: unknown) => {
        // Only an archive's own read budget becomes a preview refusal.
        if (
          isArchive &&
          (S3ObjectBudgetError.is(error) || BodyByteLimitError.is(error))
        ) {
          return archiveTooLarge();
        }
        // Other read failures keep their rejection path and Error identity.
        return await Promise.reject(
          error instanceof Error
            ? error
            : new UnhandledException({ cause: error }),
        );
      },
    );

  // Parse outside the transaction. Only release a result while the same live
  // source is share-locked, after its delivery has been recorded.
  const deliver = async <T extends Result<unknown, HandlerError>>(
    prepare: (tx: Transaction) => Promise<T> | T,
    {
      disposition = "inline",
      part,
    }: {
      disposition?: "attachment" | "inline";
      /** The part delivered (`attachment:2`), when it is not the stored file itself. */
      part?: string;
    } = {},
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
          action: CONTENT_DELIVERY_AUDIT_ACTION[disposition],
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entityId,
          workspaceId,
          metadata: {
            disposition,
            fieldId,
            ...(part === undefined ? {} : { part }),
            format: format.auditFormat,
            mimeType: content.mimeType,
            sizeBytes: content.sizeBytes,
          },
        });
      }
      return prepared;
    });
  return Result.ok({
    key,
    fileName: content.fileName,
    mimeType: format.mimeType,
    format,
    entityId,
    load,
    deliver,
    /** The code page the reading organization's ZIP names tie in. */
    zipNameCodePage: zipNameCodePageSource(scopedDb, organizationId),
  });
};

/**
 * Reads a stored file that `accept` recognizes, outside any lock, and hands
 * back `deliver`, which releases a result only while the same live version is
 * share-locked and after its delivery has been recorded.
 */
const loadFileSource = async <TFormat extends FileSourceFormat>(
  options: LegalFileReadOptions,
  accept: (content: StoredFileContent) => TFormat | null,
) => {
  const opened = await openFileSource(options, accept);
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const { load, ...file } = opened.value;
  const source = await load();
  return source.isErr()
    ? Result.err(source.error)
    : Result.ok({ ...file, source: source.value });
};
