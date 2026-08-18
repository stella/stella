import { Result } from "better-result";
import { t } from "elysia";

import { contactExtractionUploads } from "@/api/db/schema";
import { contactExtractionUploadKey } from "@/api/handlers/contacts/contact-extraction-upload";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveUploadMime } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { presignUploadUrl } from "@/api/lib/s3-presign";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import {
  PRESIGN_URL_EXPIRY_SECONDS,
  sha256HexToBase64,
} from "@/api/lib/uploads/runtime";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const bodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  mimeType: t.String({ maxLength: 255 }),
  size: t.Integer({ minimum: 1, maximum: FILE_SIZE_LIMIT_BYTES.document }),
  sha256Hex: t.RegExp(/^[0-9a-f]{64}$/u),
});

const config = {
  permissions: { contact: ["create"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: bodySchema,
} satisfies HandlerConfig;

const presignProcuracao = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
    const sanitizedName = sanitizeFilenamePreservingExtension(body.name);
    const mimeType = resolveUploadMime({
      declaredMime: body.mimeType,
      fileName: sanitizedName,
    });
    if (mimeType !== DOCX_MIME_TYPE) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "The source file must be a DOCX document.",
        }),
      );
    }

    const uploadId = createSafeId<"contactExtractionUpload">();
    const key = contactExtractionUploadKey({
      organizationId: session.activeOrganizationId,
      uploadId,
    });
    const expiresAt = new Date(Date.now() + PRESIGN_URL_EXPIRY_SECONDS * 1000);
    const presign = await presignUploadUrl({
      key,
      expiresIn: PRESIGN_URL_EXPIRY_SECONDS,
      contentType: mimeType,
      contentLength: body.size,
      sha256Base64: sha256HexToBase64(body.sha256Hex),
      scope: {
        organizationId: session.activeOrganizationId,
        workspaceId: null,
      },
      tagAsTemporaryUpload: true,
    });
    if (Result.isError(presign)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to issue upload URL",
          cause: presign.error,
        }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — presigned upload intent is ephemeral bookkeeping
        await tx.insert(contactExtractionUploads).values({
          id: uploadId,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          declaredName: sanitizedName,
          declaredMime: mimeType,
          declaredSize: body.size,
          declaredSha256: body.sha256Hex,
          expiresAt,
        });
      }),
    );

    return Result.ok({
      uploadId,
      url: presign.value.url,
      headers: presign.value.headers,
      expiresAt: expiresAt.toISOString(),
    });
  },
);

export default presignProcuracao;
