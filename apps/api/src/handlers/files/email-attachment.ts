import { Result } from "better-result";
import { t } from "elysia";

import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  isEmailAttachmentPreviewable,
  resolveEmailAttachmentMimeType,
} from "@/api/lib/files/email-to-html";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";

import {
  EMAIL_ATTACHMENT_LOAD_STATUS,
  loadEmailAttachment,
} from "./email-attachment-loader";
import {
  EMAIL_ATTACHMENT_RESPONSE_DISPOSITION,
  getEmailAttachmentResponseBytes,
} from "./email-attachment-preview";
import { scanEmailAttachmentForSave } from "./email-attachment-save-scan";

const EMAIL_ATTACHMENT_DISPOSITION_PATTERN = "^(?:inline|download)$";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "document_processing" },
  query: t.Object({
    disposition: t.String({ pattern: EMAIL_ATTACHMENT_DISPOSITION_PATTERN }),
  }),
  params: t.Object({
    workspaceId: tSafeId("workspace"),
    fieldId: tSafeId("field"),
    attachmentId: t.String(),
  }),
} satisfies HandlerConfig;

const attachmentNotFound = () => new Response(null, { status: 404 });
const attachmentNotPreviewable = () => new Response(null, { status: 415 });
const attachmentSourceTooLarge = () =>
  Response.json(
    { message: "Email exceeds the preview size limit" },
    { status: 413 },
  );
const attachmentUnreadable = () =>
  Response.json(
    { message: "Failed to parse email attachment" },
    { status: 422 },
  );
const attachmentRejected = (message: string) =>
  Response.json({ message }, { status: 422 });

export default createSafeHandler(
  config,
  async function* ({
    params: { attachmentId, fieldId },
    query: { disposition },
    recordAuditEvent,
    scopedDb,
    session,
    workspaceId,
  }): SafeHandlerGenerator<Response> {
    const attachment = yield* loadEmailAttachment({
      attachmentId,
      fieldId,
      organizationId: session.activeOrganizationId,
      scopedDb,
      secret: env.BETTER_AUTH_SECRET,
      workspaceId,
    });
    if (attachment.status === EMAIL_ATTACHMENT_LOAD_STATUS.notFound) {
      return Result.ok(attachmentNotFound());
    }
    if (attachment.status === EMAIL_ATTACHMENT_LOAD_STATUS.tooLarge) {
      return Result.ok(attachmentSourceTooLarge());
    }
    if (attachment.status === EMAIL_ATTACHMENT_LOAD_STATUS.unreadable) {
      return Result.ok(attachmentUnreadable());
    }

    // Preview and download stream the same bytes email-attachment/create.ts
    // persists as a document, so they carry the same scan requirement.
    const scanResult = await scanEmailAttachmentForSave({
      bytes: attachment.bytes,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
    if (Result.isError(scanResult)) {
      return Result.ok(attachmentRejected(scanResult.error.message));
    }

    const attachmentMimeType = resolveEmailAttachmentMimeType({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
    if (
      disposition === "inline" &&
      !isEmailAttachmentPreviewable(attachmentMimeType)
    ) {
      return Result.ok(attachmentNotPreviewable());
    }

    const mimeType =
      disposition === "inline"
        ? (attachmentMimeType ?? "application/octet-stream")
        : "application/octet-stream";
    const responseBytes = getEmailAttachmentResponseBytes({
      bytes: attachment.bytes,
      disposition:
        disposition === "inline"
          ? EMAIL_ATTACHMENT_RESPONSE_DISPOSITION.inline
          : EMAIL_ATTACHMENT_RESPONSE_DISPOSITION.download,
      mimeType: attachmentMimeType,
    });
    const fileName = sanitizeFilename(attachment.fileName);
    if (disposition === "download") {
      yield* Result.await(
        Result.tryPromise(
          async () =>
            await scopedDb(
              async (tx) =>
                await recordAuditEvent(tx, {
                  action: AUDIT_ACTION.DOWNLOAD,
                  resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                  resourceId: attachment.sourceEntityId,
                  metadata: {
                    attachmentId,
                    fieldId,
                    mimeType: attachmentMimeType ?? "application/octet-stream",
                    sizeBytes: attachment.bytes.byteLength,
                  },
                }),
            ),
        ),
      );
    }
    return Result.ok(
      secureDocumentResponse({
        body: new Uint8Array(responseBytes),
        contentLength: responseBytes.byteLength,
        contentType: mimeType,
        disposition: disposition === "download" ? "attachment" : "inline",
        fileName,
      }),
    );
  },
);
