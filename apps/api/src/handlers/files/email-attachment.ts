import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { status, t } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  createEmailAttachmentDescriptor,
  findEmailAttachmentIndex,
} from "@/api/lib/files/email-attachment-token";
import {
  parseEmail,
  buildEmailPreview,
  isEmailAttachmentPreviewable,
  resolveEmailMimeType,
} from "@/api/lib/files/email-to-html";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

const emailAttachmentFieldQuery = async (
  scopedDb: ScopedDb,
  fieldId: SafeId<"field">,
  workspaceId: SafeId<"workspace">,
) =>
  await scopedDb((tx) =>
    tx
      .select({
        content: fields.content,
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
      .where(and(eq(fields.id, fieldId), isNull(entityVersions.deletedAt)))
      .limit(1),
  );

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  query: t.Object({ disposition: t.UnionEnum(["inline", "download"]) }),
  params: workspaceParams({
    fieldId: tSafeId("field"),
    attachmentId: t.String({ minLength: 1, maxLength: 64 }),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    params: { attachmentId, fieldId },
    query: { disposition },
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
      return Result.ok(status(404));
    }

    const content = row.content;
    const emailMimeType = resolveEmailMimeType({
      fileName: content.fileName,
      mimeType: content.mimeType,
    });
    if (!emailMimeType) {
      return Result.ok(status(404));
    }

    const attachmentIndex = findEmailAttachmentIndex({
      descriptor: attachmentId,
      secret: env.BETTER_AUTH_SECRET,
      sourceFileId: content.id,
      sourceVersionId: row.entityVersionId,
    });
    if (attachmentIndex === null) {
      return Result.ok(status(404));
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
      return Result.ok(
        status(422, { message: "Failed to parse email attachment" }),
      );
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
      return Result.ok(status(404));
    }
    if (
      disposition === "inline" &&
      !isEmailAttachmentPreviewable(attachment.mimeType)
    ) {
      return Result.ok(status(415));
    }

    const mimeType =
      disposition === "inline"
        ? (attachment.mimeType?.split(";").at(0)?.trim().toLowerCase() ??
          "application/octet-stream")
        : "application/octet-stream";
    const fileName = sanitizeFilename(attachment.fileName ?? "attachment");
    const safeDisposition = contentDisposition(fileName).replace(
      /^attachment;/u,
      `${disposition};`,
    );
    return Result.ok(
      new Response(attachment.bytes, {
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
