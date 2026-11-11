/**
 * One SharePoint file copied into a matter: a one-way, read-only snapshot.
 *
 * The bytes go through the same scan, encryption detection and document
 * write owners as an upload, so OCR, search indexing, permissions and audit
 * behave as for any uploaded file. Each stored version records the drive item,
 * its ETag and the SHA-256 of the copied bytes as a `sharepoint` document
 * source; a later import of the same item into the same matter compares the
 * digests, so it adds a version only when the file's content changed in
 * SharePoint and is a no-op otherwise. The ETag is provenance only: it also
 * changes on a rename or a metadata edit.
 */
import { panic, Result } from "better-result";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { SHAREPOINT_REFUSAL_CODE } from "@stll/api-contract/sharepoint";
import { sha256Hex } from "@stll/sha256/bun";

import type { SafeDb, SafeDbError, ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions } from "@/api/db/schema";
import {
  downloadSharepointFile,
  getSharepointDriveItem,
  SHAREPOINT_ITEM_KIND,
  type SharepointDriveItem,
  type SharepointGraphError,
} from "@/api/handlers/sharepoint/graph-client";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentSource } from "@/api/lib/document-source";
import {
  authorizeDocumentWrite,
  authorizeDocumentWriteAccess,
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import {
  detectFileEncryption,
  uploadFileEncryption,
} from "@/api/lib/files/detect-file-encryption";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

const GENERIC_MIME_TYPE = "application/octet-stream";

type SharepointSource = Extract<DocumentSource, { kind: "sharepoint" }>;

/** What an import does with one drive item, given what the matter holds. */
export type SharepointImportPlan =
  | { type: "create" }
  | { type: "version"; entityId: SafeId<"entity"> }
  | { type: "unchanged"; entityId: SafeId<"entity"> };

export const planSharepointImport = ({
  imported,
  contentHash,
}: {
  /** The matter's latest copy of this item, or `null` when it has none. */
  imported: { entityId: SafeId<"entity">; contentHash: string } | null;
  /** SHA-256 of the bytes SharePoint holds now. */
  contentHash: string;
}): SharepointImportPlan => {
  if (imported === null) {
    return { type: "create" };
  }
  return imported.contentHash === contentHash
    ? { type: "unchanged", entityId: imported.entityId }
    : { type: "version", entityId: imported.entityId };
};

/** One requested item's outcome; failures do not stop the other items. */
export type SharepointImportResult = {
  driveId: string;
  itemId: string;
} & (
  | {
      status: "created" | "versioned";
      entityId: SafeId<"entity">;
      name: string;
      versionNumber: number;
    }
  | { status: "unchanged"; entityId: SafeId<"entity">; name: string }
  | { status: "failed"; code: string; message: string }
);

type ImportTarget = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  workspace: AccessibleWorkspace | null;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  recordAuditEvent: AuditRecorder;
  parentId: SafeId<"entity"> | null;
};

/**
 * The newest live version in this matter copied from the item, and the ETag
 * it was copied at. Versions of deleted documents are gone with them, so a
 * document deleted after import is imported afresh.
 */
const findImportedCopy = async ({
  safeDb,
  workspaceId,
  driveId,
  itemId,
}: {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  driveId: string;
  itemId: string;
}) => {
  const containment = JSON.stringify({
    kind: "sharepoint",
    driveId,
    itemId,
  });
  const rows = await safeDb((tx) =>
    tx
      .select({
        entityId: entityVersions.entityId,
        source: entityVersions.source,
      })
      .from(entityVersions)
      .innerJoin(
        entities,
        and(
          eq(entities.id, entityVersions.entityId),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(entityVersions.workspaceId, workspaceId),
          isNull(entityVersions.deletedAt),
          sql`${entityVersions.source} @> ${containment}::text::jsonb`,
        ),
      )
      .orderBy(desc(entityVersions.createdAt))
      .limit(1),
  );
  return rows.map((found) => {
    const row = found.at(0);
    if (row === undefined) {
      return null;
    }
    if (row.source?.kind !== "sharepoint") {
      return panic(
        "A SharePoint containment match must be a SharePoint source",
      );
    }
    return { entityId: row.entityId, contentHash: row.source.contentHash };
  });
};

const failed = (
  { driveId, itemId }: { driveId: string; itemId: string },
  error: HandlerError,
): SharepointImportResult => ({
  driveId,
  itemId,
  status: "failed",
  code: error.code ?? `http_${error.status}`,
  message: error.message,
});

const storeFailure = (
  error:
    | { _tag: "DocumentTooLargeError" }
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError" }
    | { _tag: "MissingFilePropertyError" }
    | { _tag: "EntityVersionTargetError"; code: string; message: string }
    | DocumentWriteRefusedError
    | OrganizationFileUsageError,
): HandlerError => {
  if (error instanceof OrganizationFileUsageError) {
    return organizationFileUsageHandlerError(error);
  }
  if (DocumentWriteRefusedError.is(error)) {
    return documentWriteRefusalHandlerError(error);
  }
  switch (error._tag) {
    case "DocumentTooLargeError":
      return new HandlerError({
        status: 413,
        code: SHAREPOINT_REFUSAL_CODE.fileTooLarge,
        message: "The file exceeds the document size limit",
      });
    case "EntityLimitError":
      return new HandlerError({
        status: 409,
        code: "entity_limit_reached",
        message: "The matter has reached its document limit",
      });
    case "InvalidParentError":
      return new HandlerError({
        status: 404,
        code: "folder_not_found",
        message: "The target folder was not found",
      });
    case "MissingFilePropertyError":
      return new HandlerError({
        status: 422,
        code: "matter_cannot_store_documents",
        message: "The matter cannot store documents",
      });
    case "EntityVersionTargetError":
      return new HandlerError({
        status: 409,
        code: error.code.replaceAll("-", "_"),
        message: error.message,
      });
    default:
      return panic("Unhandled SharePoint import store failure");
  }
};

/** Bytes checked like an upload: scanned, then their encryption detected. */
const inspectBytes = async ({
  bytes,
  item,
}: {
  bytes: Uint8Array;
  item: SharepointDriveItem;
}) => {
  const mimeType = item.mimeType ?? GENERIC_MIME_TYPE;
  const scanned = await scanUpload({
    bytes,
    ownership: "transfer",
    declaredMimeType: mimeType,
    fileName: item.name,
  });
  if (Result.isError(scanned)) {
    return Result.err(
      FileScanRejectedError.is(scanned.error)
        ? new HandlerError({
            ...scanned.error.rejection,
            status: 422,
            code: "file_rejected",
          })
        : new HandlerError({
            status: 422,
            code: "file_scan_failed",
            message: "File security scan failed",
          }),
    );
  }
  const encryption = uploadFileEncryption(
    await detectFileEncryption({ mimeType, scanned: scanned.value }),
    handlerErrorContext("sharepointImport.detectEncryption", {
      mimeType,
      sizeBytes: String(scanned.value.bytes.byteLength),
    }),
  );
  if (encryption === null) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: "file_unreadable",
        message: "The file appears corrupted",
      }),
    );
  }
  return Result.ok({ scanned: scanned.value, encryption, mimeType });
};

/** Graph failures that end the whole request rather than one item. */
const endsRequest = (error: SharepointGraphError): boolean =>
  error.code === SHAREPOINT_REFUSAL_CODE.reconnectRequired ||
  error.code === SHAREPOINT_REFUSAL_CODE.throttled;

type ImportFileOptions = {
  accessToken: Parameters<typeof getSharepointDriveItem>[0]["accessToken"];
  ref: { driveId: string; itemId: string };
  target: ImportTarget;
};

/**
 * Imports one item. A revoked grant or Graph throttling fails the request so
 * the caller reconnects or retries it whole; a retry converges, since items
 * already copied at their current ETag are no-ops.
 */
export const importSharepointFile = async ({
  accessToken,
  ref,
  target,
}: ImportFileOptions): Promise<
  Result<SharepointImportResult, SharepointGraphError | SafeDbError>
> => {
  const item = await getSharepointDriveItem({ accessToken, ...ref });
  if (Result.isError(item)) {
    return endsRequest(item.error) ? item : Result.ok(failed(ref, item.error));
  }
  const { eTag, webUrl, size, kind, name } = item.value;
  if (kind !== SHAREPOINT_ITEM_KIND.file) {
    return Result.ok(
      failed(
        ref,
        new HandlerError({
          status: 422,
          code: SHAREPOINT_REFUSAL_CODE.notAFile,
          message: "Only files can be imported, not folders or notebooks",
        }),
      ),
    );
  }
  if (size === null || size > FILE_SIZE_LIMIT_BYTES.document) {
    return Result.ok(
      failed(
        ref,
        new HandlerError({
          status: 413,
          code: SHAREPOINT_REFUSAL_CODE.fileTooLarge,
          message: `The file exceeds the ${FILE_SIZE_LIMIT_BYTES.document}-byte document size limit`,
        }),
      ),
    );
  }
  if (eTag === null || webUrl === null) {
    return Result.ok(
      failed(
        ref,
        new HandlerError({
          status: 502,
          code: "upstream_unavailable",
          message: "Microsoft Graph did not report the file's version",
        }),
      ),
    );
  }

  const imported = await findImportedCopy({
    safeDb: target.safeDb,
    workspaceId: target.workspaceId,
    ...ref,
  });
  if (Result.isError(imported)) {
    return Result.err(imported.error);
  }
  const bytes = await downloadSharepointFile({
    accessToken,
    ...ref,
    maxBytes: FILE_SIZE_LIMIT_BYTES.document,
  });
  if (Result.isError(bytes)) {
    return endsRequest(bytes.error)
      ? bytes
      : Result.ok(failed(ref, bytes.error));
  }
  // Hash before the scan takes ownership of the buffer.
  const contentHash = sha256Hex(bytes.value);
  const plan = planSharepointImport({
    imported: imported.value,
    contentHash,
  });
  if (plan.type === "unchanged") {
    return Result.ok({
      ...ref,
      status: "unchanged",
      entityId: plan.entityId,
      name,
    });
  }
  const inspected = await inspectBytes({
    bytes: bytes.value,
    item: item.value,
  });
  if (Result.isError(inspected)) {
    return Result.ok(failed(ref, inspected.error));
  }
  const { scanned, encryption, mimeType } = inspected.value;
  const source: SharepointSource = {
    kind: "sharepoint",
    driveId: item.value.driveId,
    itemId: item.value.id,
    eTag,
    webUrl,
    contentHash,
  };

  switch (plan.type) {
    case "create": {
      const created = await createEntityFromBuffer({
        scopedDb: target.scopedDb,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        userId: target.userId,
        recordAuditEvent: target.recordAuditEvent,
        buffer: scanned.bytes,
        fileName: name,
        mimeType,
        encryption,
        parentId: target.parentId,
        scanWarnings: scanned.scanWarnings ?? undefined,
        source,
      });
      return Result.ok(
        Result.isError(created)
          ? failed(ref, storeFailure(created.error))
          : {
              ...ref,
              status: "created",
              entityId: created.value.entityId,
              name: created.value.fileName,
              versionNumber: 1,
            },
      );
    }
    case "version": {
      const access = authorizeDocumentWriteAccess({
        authority: target.memberRole,
        workspace: target.workspace,
        operation: {
          type: "new_version",
          workspaceId: target.workspaceId,
          entityId: plan.entityId,
        },
      });
      if (Result.isError(access)) {
        return Result.ok(failed(ref, storeFailure(access.error)));
      }
      const authorized = await authorizeDocumentWrite({
        access: access.value,
        safeDb: target.safeDb,
      });
      if (Result.isError(authorized)) {
        return DocumentWriteRefusedError.is(authorized.error)
          ? Result.ok(failed(ref, storeFailure(authorized.error)))
          : Result.err(authorized.error);
      }
      const versioned = await createEntityVersionFromBuffer({
        safeDb: target.safeDb,
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
        entityId: plan.entityId,
        userId: target.userId,
        recordAuditEvent: target.recordAuditEvent,
        buffer: scanned.bytes,
        fileName: name,
        mimeType,
        encryption,
        source,
        writePolicy: { type: "replace-current-file" },
        scanWarnings: scanned.scanWarnings ?? undefined,
      });
      return Result.ok(
        Result.isError(versioned)
          ? failed(ref, storeFailure(versioned.error))
          : {
              ...ref,
              status: "versioned",
              entityId: versioned.value.entityId,
              name: versioned.value.fileName,
              versionNumber: versioned.value.versionNumber,
            },
      );
    }
    default: {
      plan satisfies never;
      return panic("Unhandled SharePoint import plan");
    }
  }
};
