import { Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DocumentWriteRefusedError,
  documentWriteRefusalHandlerError,
} from "@/api/lib/entities/authorize-document-write";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { validateParentId } from "@/api/lib/entities/validate-parent-id";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

type CreateBlankDocumentOptions = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  buffer: Uint8Array | ArrayBuffer;
  name: string;
  parentId: SafeId<"entity"> | null;
};

export const createBlankDocument = async ({
  scopedDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  buffer,
  name,
  parentId,
}: CreateBlankDocumentOptions) => {
  if (parentId) {
    const parentError = await scopedDb(
      async (tx) => await validateParentId({ tx, parentId, workspaceId }),
    );
    if (parentError) {
      return Result.err(
        new HandlerError({ status: 400, message: parentError }),
      );
    }
  }

  return await createEntityFromBuffer({
    scopedDb,
    organizationId,
    workspaceId,
    userId,
    recordAuditEvent,
    buffer,
    fileName: `${name}.docx`,
    mimeType: DOCX_MIME_TYPE,
    encryption: serverBuiltFileEncryption(),
    parentId,
  }).then((result) => Result.mapError(result, toHandlerError));
};

const toHandlerError = (
  error:
    | OrganizationFileUsageError
    | { _tag: "DocumentTooLargeError" }
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError"; message: string }
    | { _tag: "MissingFilePropertyError" }
    | DocumentWriteRefusedError,
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
        message: "The generated document exceeds the document size limit.",
      });
    case "EntityLimitError":
      return new HandlerError({
        status: 409,
        message: "This matter has reached the document limit.",
      });
    case "MissingFilePropertyError":
      return new HandlerError({
        status: 422,
        message: "This matter is missing a file property.",
      });
    case "InvalidParentError":
      return new HandlerError({ status: 400, message: error.message });
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};
