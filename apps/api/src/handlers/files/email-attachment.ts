import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  createEmailAttachmentDescriptor,
  findEmailAttachmentIndex,
} from "@/api/lib/files/email-attachment-token";
import {
  parseEmail,
  buildEmailPreview,
  isEmailAttachmentPreviewable,
  resolveEmailAttachmentMimeType,
  resolveEmailMimeType,
} from "@/api/lib/files/email-to-html";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

const EMAIL_ATTACHMENT_DISPOSITION_PATTERN = "^(?:inline|download)$";

const emailAttachmentFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
        entityId: entities.id,
        entityVersionId: entityVersions.id,
      })
      .from(fields)
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.entityId, entities.id),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      // Withdrawn versions remain under legal hold, but their bytes must not
      // remain reachable through a previously captured field identifier.
      .where(and(eq(fields.id, fieldId), isNull(entityVersions.deletedAt)))
      .limit(1),
  );

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

export default createSafeHandler(
  config,
  async function* ({
    params: { attachmentId, fieldId },
    query: { disposition },
    recordAuditEvent,
    scopedDb,
    session,
    workspaceId,
  }) {
    const rows = yield* Result.await(
      Result.tryPromise(
        async () =>
          await emailAttachmentFieldQuery(scopedDb, fieldId, workspaceId),
      ),
    );
    const row = rows.at(0);
    if (!row || row.content.type !== "file" || row.content.encrypted) {
      return Result.ok(attachmentNotFound());
    }

    const content = row.content;
    const emailMimeType = resolveEmailMimeType({
      fileName: content.fileName,
      mimeType: content.mimeType,
    });
    if (!emailMimeType) {
      return Result.ok(attachmentNotFound());
    }

    const attachmentIndex = findEmailAttachmentIndex({
      descriptor: attachmentId,
      secret: env.BETTER_AUTH_SECRET,
      sourceFileId: content.id,
      sourceVersionId: row.entityVersionId,
    });
    if (attachmentIndex === null) {
      return Result.ok(attachmentNotFound());
    }
    if (content.sizeBytes > FILE_SIZE_LIMIT_BYTES.document) {
      return Result.ok(attachmentSourceTooLarge());
    }

    const sourceBuffer = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readS3ArrayBuffer(
            createFileKey({
              organizationId: session.activeOrganizationId,
              workspaceId,
              fileId: content.id,
              mimeType: content.mimeType,
            }),
          ),
      ),
    );
    const parsedResult = await Result.tryPromise({
      try: async () => await parseEmail(sourceBuffer, emailMimeType),
      catch: (cause) => cause,
    });
    if (Result.isError(parsedResult)) {
      captureError(parsedResult.error, {
        fieldId,
        mimeType: emailMimeType,
        workspaceId,
      });
      return Result.ok(attachmentUnreadable());
    }
    const preview = buildEmailPreview(parsedResult.value, {
      createAttachmentId: (index) =>
        createEmailAttachmentDescriptor({
          attachmentIndex: index,
          secret: env.BETTER_AUTH_SECRET,
          sourceFileId: content.id,
          sourceVersionId: row.entityVersionId,
        }),
    });
    const descriptor = preview.attachments.find(
      ({ id }) => id === attachmentId,
    );
    const attachment = parsedResult.value.attachments.at(attachmentIndex);
    if (!descriptor || !attachment) {
      return Result.ok(attachmentNotFound());
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
    const fileName = sanitizeFilename(attachment.fileName ?? "attachment");
    const safeDisposition = contentDisposition(
      fileName,
      disposition === "download" ? "attachment" : "inline",
    );
    if (disposition === "download") {
      yield* Result.await(
        Result.tryPromise(
          async () =>
            await scopedDb(
              async (tx) =>
                await recordAuditEvent(tx, {
                  action: AUDIT_ACTION.DOWNLOAD,
                  resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                  resourceId: row.entityId,
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
      new Response(new Uint8Array(attachment.bytes), {
        headers: {
          ...RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
          "Cache-Control": "private, no-store",
          "Content-Disposition": safeDisposition,
          "Content-Length": String(attachment.bytes.byteLength),
          "Content-Type": mimeType,
        },
      }),
    );
  },
);
