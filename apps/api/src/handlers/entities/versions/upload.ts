import { panic, Result } from "better-result";

import { uploadVersionBodySchema } from "@/api/handlers/entities/upload-version-schema";
import { entityVersionRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { UPLOAD_DOCUMENT_SOURCE } from "@/api/lib/document-source";
import {
  authorizeDocumentWrite,
  authorizeDocumentWriteAccess,
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
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
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Stores document content and returns operation metadata rather than stored-file bytes.",
  },
  description:
    "Add a new version to an existing document by uploading a file over a " +
    "multipart request, replacing that document's current file. The bytes " +
    "are scanned and a rejected file fails the call; a read-only entity, an " +
    "open desktop editing session, and a current version that changed under " +
    "you are all conflicts. An agent surface cannot send multipart: use " +
    "uploads.create with purpose entity_version and then uploads.update.",
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityVersionRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  transport: {
    type: "file-input",
    input: { field: "file", required: true, mediaTypes: [] },
    alternative: {
      type: "complete",
      via: ["uploads.create", "uploads.update"],
      note: "presign with purpose entity_version, PUT the bytes to the returned URL, then finalize",
    },
  },
  body: uploadVersionBodySchema,
} satisfies WorkspaceHandlerConfig;

/**
 * Legacy multipart transport for creating an entity version. The canonical
 * persistence transaction lives in createEntityVersionFromBuffer, which is
 * also used by server-generated template fills; the presigned transport joins
 * the same writeFileVersion transaction after promoting its staged object.
 *
 * @yields Safe database and handler errors to createSafeHandler.
 */
export default createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    body,
    session,
    user,
    memberRole,
    getWorkspaceAccess,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;
    const userId = user.id;
    const { entityId, file } = body;
    const sanitizedName = sanitizeFilename(file.name);

    // Reject an invalid target before spending scan/storage work. The shared
    // transaction repeats the entity checks under FOR UPDATE to close the race.
    const access = authorizeDocumentWriteAccess({
      authority: memberRole,
      workspace: await getWorkspaceAccess(workspaceId),
      operation: { type: "new_version", workspaceId, entityId },
    });
    if (Result.isError(access)) {
      return Result.err(documentWriteRefusalHandlerError(access.error));
    }
    const authorized = await authorizeDocumentWrite({
      access: access.value,
      safeDb,
    });
    if (Result.isError(authorized)) {
      if (DocumentWriteRefusedError.is(authorized.error)) {
        return Result.err(documentWriteRefusalHandlerError(authorized.error));
      }
      return Result.err(authorized.error);
    }
    const target = authorized.value.operation;

    const scanned = await scanUpload({
      bytes: await file.arrayBuffer(),
      declaredMimeType: file.type,
      fileName: sanitizedName,
    });
    if (Result.isError(scanned)) {
      return Result.err(
        scanned.error instanceof FileScanRejectedError
          ? new HandlerError({ ...scanned.error.rejection, status: 422 })
          : new HandlerError({ status: 422, message: "File scan failed" }),
      );
    }
    const encryption = uploadFileEncryption(
      await detectFileEncryption({
        mimeType: file.type,
        scanned: scanned.value,
      }),
      {
        mimeType: file.type,
        sizeBytes: String(scanned.value.bytes.byteLength),
      },
    );
    if (encryption === null) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Failed to open PDF: file appears corrupted",
        }),
      );
    }

    const created = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createEntityVersionFromBuffer({
            safeDb,
            organizationId,
            workspaceId: target.workspaceId,
            entityId: target.entityId,
            userId,
            recordAuditEvent,
            buffer: scanned.value.bytes,
            fileName: sanitizedName,
            mimeType: file.type,
            encryption,
            source: UPLOAD_DOCUMENT_SOURCE,
            writePolicy: { type: "replace-current-file" },
            scanWarnings: scanned.value.scanWarnings ?? undefined,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to store entity version",
            cause,
          }),
      }),
    );
    if (Result.isError(created)) {
      if (created.error instanceof OrganizationFileUsageError) {
        return Result.err(organizationFileUsageHandlerError(created.error));
      }
      let status: 400 | 404 | 409 | 413;
      switch (created.error.code) {
        case "current-version-not-found":
        case "entity-not-found": {
          status = 404;
          break;
        }
        case "document-too-large": {
          status = 413;
          break;
        }
        case "entity-read-only": {
          status = 409;
          break;
        }
        case "current-version-changed":
        case "edit-session-open":
        case "workspace-not-active": {
          status = 409;
          break;
        }
        case "missing-file-field": {
          status = 400;
          break;
        }
        case "source-version-not-found":
        case "target-file-not-found": {
          status = 409;
          break;
        }
        default: {
          created.error satisfies never;
          return panic("Unhandled entity version failure", created.error);
        }
      }
      return Result.err(
        new HandlerError({ status, message: created.error.message }),
      );
    }

    return Result.ok({
      fieldId: created.value.fieldId,
      versionId: created.value.entityVersionId,
      versionNumber: created.value.versionNumber,
    });
  },
);
