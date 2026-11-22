import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import {
  filePartId,
  filePartIdSchema,
  parseFilePartId,
} from "@stll/api-contract/file-parts";
import { workspaceAcceptsWrites } from "@stll/api-contract/workspace-status";

import { captureError, detached } from "@/api/lib/analytics/capture";
import {
  ACCOUNT_ACCESS,
  createSafeHandler,
  type WorkspaceHandlerConfig,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import {
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import {
  detectFileEncryption,
  uploadFileEncryption,
} from "@/api/lib/files/detect-file-encryption";
import { readFilePart } from "@/api/lib/files/file-part";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import { maybeStartUploadTriggeredFlows } from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { broadcastOrganizationResourceSetUpdated } from "@/api/lib/resource-realtime";

import { consumeFilePartSaveRateLimit } from "./part-save-rate-limit";
import { scanFilePartForSave } from "./part-save-scan";

/** The saved copy's creation records where its bytes came from instead. */
const copyRecordedOnCreation: AuditRecorder = async () => {
  await Promise.resolve();
};

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Saves a part of a file as a document without returning stored-file bytes.",
  },
  description:
    "Save one part of a file (an email's attachment, a container's member, a signed envelope's document) into an accessible matter as a document. Returns the created entity and file field identifiers.",
  permissions: { workspace: ["read"], entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({ fieldId: resourceIdSchema("field") }),
  body: v.object({
    /** The part, such as `attachment:0`, as the file's preview lists it. */
    part: filePartIdSchema,
    destinationWorkspaceId: resourceIdSchema("workspace"),
    parentId: v.nullable(resourceIdSchema("entity")),
  }),
} satisfies WorkspaceHandlerConfig;

const saveFilePart = createSafeHandler(
  config,
  async function* ({
    body: { destinationWorkspaceId, parentId, part: partId },
    createAuditRecorder,
    getWorkspaceAccess,
    params: { fieldId },
    request,
    scopedDb,
    server,
    session,
    user,
    workspaceId,
  }) {
    const withinRateLimit = yield* Result.await(
      Result.tryPromise(
        async () =>
          await consumeFilePartSaveRateLimit({
            request,
            server: server ?? null,
          }),
      ),
    );
    if (!withinRateLimit) {
      return Result.err(
        new HandlerError({
          status: 429,
          message: "Too many saves. Try again shortly.",
        }),
      );
    }

    const destinationWorkspace = yield* Result.await(
      Result.tryPromise(
        async () => await getWorkspaceAccess(destinationWorkspaceId),
      ),
    );
    if (!workspaceAcceptsWrites(destinationWorkspace?.status)) {
      return Result.err(
        new HandlerError({ status: 404, message: "Target matter not found" }),
      );
    }

    const part = parseFilePartId(partId);
    if (part === null) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "The file has no such part",
        }),
      );
    }
    // The same read, access and liveness check as the part link; the copy's
    // creation is what the audit trail records.
    const read = yield* Result.await(
      readFilePart({
        scopedDb,
        workspaceId,
        organizationId: session.activeOrganizationId,
        fieldId,
        recordAuditEvent: copyRecordedOnCreation,
        part,
        disposition: "attachment",
      }),
    );
    const attachment = {
      bytes: read.bytes,
      fileName: read.fileName,
      mimeType: read.mimeType,
      sourceEntityId: read.entityId,
    };

    const { scanned, scanWarnings } = yield* Result.await(
      scanFilePartForSave({
        bytes: attachment.bytes,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      }),
    );

    const encryption = uploadFileEncryption(
      await detectFileEncryption({ mimeType: attachment.mimeType, scanned }),
      handlerErrorContext("filePart.detectEncryption", {
        mimeType: attachment.mimeType,
        sizeBytes: String(attachment.bytes.byteLength),
      }),
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
      createEntityFromBuffer({
        authority: CALLER_AUTHORIZED,
        scopedDb,
        organizationId: session.activeOrganizationId,
        workspaceId: destinationWorkspaceId,
        userId: user.id,
        recordAuditEvent: createAuditRecorder({
          workspaceId: destinationWorkspaceId,
        }),
        buffer: attachment.bytes,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        encryption,
        parentId,
        provenance: {
          type: "file_part",
          part: filePartId(part),
          sourceEntityId: attachment.sourceEntityId,
          sourceFieldId: fieldId,
          sourceWorkspaceId: workspaceId,
        },
        scanWarnings,
      }).then((result) => Result.mapError(result, toSaveHandlerError)),
    );

    detached(
      async () =>
        maybeStartUploadTriggeredFlows({
          entityId: created.entityId,
          workspaceId: destinationWorkspaceId,
          organizationId: session.activeOrganizationId,
          fileName: created.fileName,
        }).catch((error: unknown) => {
          captureError(
            error,
            handlerErrorContext("filePart.save.capture", {
              entityId: created.entityId,
              workspaceId: destinationWorkspaceId,
            }),
          );
        }),
      "file-part-save.maybe-start-upload-triggered-flows",
    );
    broadcastOrganizationResourceSetUpdated(
      session.activeOrganizationId,
      RESOURCE_TYPE.WORKSPACE,
    );

    return Result.ok({
      entityId: created.entityId,
      fieldId: created.fieldId,
      fileName: created.fileName,
      workspaceId: destinationWorkspaceId,
    });
  },
);

declareAggregateMutation(saveFilePart, {
  type: "independent",
  reason:
    "Copies one part of a file into a matter as a new document through createEntityFromBuffer, which takes the destination matter's own locks before it writes; it owns no registered aggregate.",
});

export default saveFilePart;

const toSaveHandlerError = (
  error:
    | { _tag: "DocumentTooLargeError" }
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError" }
    | { _tag: "MissingFilePropertyError" }
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
        message: "The file exceeds the document size limit",
      });
    case "EntityLimitError":
      return new HandlerError({
        status: 409,
        message: "The target matter has reached its document limit",
      });
    case "InvalidParentError":
      return new HandlerError({
        status: 404,
        message: "The target folder was not found",
      });
    case "MissingFilePropertyError":
      return new HandlerError({
        status: 422,
        message: "The target matter cannot store documents",
      });
    default:
      return unreachable("Unhandled file part save error");
  }
};
