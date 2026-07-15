import { Result } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { validateParentId } from "@/api/handlers/entities/validate-parent-id";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
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
    parentId,
  }).then((result) => Result.mapError(result, toHandlerError));
};

const toHandlerError = (
  error: { _tag: "EntityLimitError" } | { _tag: "MissingFilePropertyError" },
): HandlerError => {
  switch (error._tag) {
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
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};
