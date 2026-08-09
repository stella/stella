import { Result } from "better-result";
import { t } from "elysia";

import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler, type HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { isEncryptedPdf } from "@/api/lib/files/pdf-utils";
import { PDF_MIME_TYPE } from "@/api/mime-types";

import {
  EMAIL_ATTACHMENT_LOAD_STATUS,
  loadEmailAttachment,
} from "../email-attachment-loader";
import { scanEmailAttachmentForSave } from "../email-attachment-save-scan";

const config = {
  description:
    "Save one attachment from an email into an accessible matter as a document. Returns the created entity and file field identifiers.",
  permissions: { workspace: ["read"], entity: ["create"] },
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({
    fieldId: tSafeId("field"),
    attachmentId: t.String({ minLength: 1, maxLength: 64 }),
  }),
  body: t.Object({
    destinationWorkspaceId: tSafeId("workspace"),
    parentId: t.Nullable(tSafeId("entity")),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    body: { destinationWorkspaceId, parentId },
    createAuditRecorder,
    getWorkspaceAccess,
    params: { attachmentId, fieldId },
    scopedDb,
    session,
    user,
    workspaceId,
  }) {
    const destinationWorkspace = yield* Result.await(
      Result.tryPromise(
        async () => await getWorkspaceAccess(destinationWorkspaceId),
      ),
    );
    if (!destinationWorkspace || destinationWorkspace.status !== "active") {
      return Result.err(
        new HandlerError({ status: 404, message: "Target matter not found" }),
      );
    }

    const attachment = yield* loadEmailAttachment({
      attachmentId,
      fieldId,
      organizationId: session.activeOrganizationId,
      scopedDb,
      secret: env.BETTER_AUTH_SECRET,
      workspaceId,
    });
    if (attachment.status === EMAIL_ATTACHMENT_LOAD_STATUS.notFound) {
      return Result.err(
        new HandlerError({ status: 404, message: "Attachment not found" }),
      );
    }
    if (attachment.status === EMAIL_ATTACHMENT_LOAD_STATUS.tooLarge) {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Email exceeds the preview size limit",
        }),
      );
    }
    if (attachment.status === EMAIL_ATTACHMENT_LOAD_STATUS.unreadable) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "The source email could not be parsed",
        }),
      );
    }

    const { scanWarnings } = yield* Result.await(
      scanEmailAttachmentForSave({
        bytes: attachment.bytes,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      }),
    );

    let encrypted = false;
    if (attachment.mimeType === PDF_MIME_TYPE) {
      const pdfBuffer = new ArrayBuffer(attachment.bytes.byteLength);
      new Uint8Array(pdfBuffer).set(attachment.bytes);
      const encryptedResult = await isEncryptedPdf(pdfBuffer);
      if (Result.isError(encryptedResult)) {
        captureError(encryptedResult.error, {
          mimeType: PDF_MIME_TYPE,
          sizeBytes: String(attachment.bytes.byteLength),
        });
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Failed to open PDF: file appears corrupted",
          }),
        );
      }
      encrypted = encryptedResult.value;
    }

    const created = yield* Result.await(
      createEntityFromBuffer({
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
        encrypted,
        parentId,
        provenance: {
          type: "email_attachment",
          attachmentId,
          sourceEntityId: attachment.sourceEntityId,
          sourceFieldId: fieldId,
          sourceWorkspaceId: workspaceId,
        },
        scanWarnings,
      }).then((result) => Result.mapError(result, toSaveHandlerError)),
    );

    return Result.ok({
      entityId: created.entityId,
      fieldId: created.fieldId,
      fileName: created.fileName,
      workspaceId: destinationWorkspaceId,
    });
  },
);

const toSaveHandlerError = (
  error:
    | { _tag: "DocumentTooLargeError" }
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError" }
    | { _tag: "MissingFilePropertyError" },
): HandlerError => {
  switch (error._tag) {
    case "DocumentTooLargeError":
      return new HandlerError({
        status: 413,
        message: "The attachment exceeds the document size limit",
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
      return unreachable("Unhandled email attachment save error");
  }
};
