/**
 * Translate a stored document via DeepL.
 *
 * Resolves the org's stored DeepL key, downloads the source
 * field's bytes from S3, ships them to DeepL's /v2/document
 * flow, then writes the translated result back as a new
 * entity in the same workspace via the shared
 * `createEntityFromBuffer` path so the new file gets the
 * usual indexing, audit, and PDF-derivative treatment.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { entities, entityVersions, fields } from "@/api/db/schema";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { decryptContent } from "@/api/lib/content-encryption";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  DeepLAuthError,
  DeepLDocumentError,
  DeepLQuotaError,
  DeepLRateLimitError,
  DeepLTimeoutError,
  DeepLUpstreamError,
  translateDocument,
} from "@/api/lib/deepl";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

// Mime types DeepL's /v2/document endpoint accepts. Anything
// outside this set is rejected before we waste an upload round
// trip (and DeepL's 50k-char minimum bill).
const DEEPL_SUPPORTED_MIME_TYPES = new Set<string>([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "text/plain",
  "text/html",
  "application/xliff+xml",
]);

const FORMALITY_VALUES = [
  "default",
  "more",
  "less",
  "prefer_more",
  "prefer_less",
] as const;

const translateBody = t.Object({
  fieldId: tSafeId("field"),
  targetLang: t.String({ minLength: 2, maxLength: 16 }),
  sourceLang: t.Optional(t.String({ minLength: 2, maxLength: 16 })),
  formality: t.Optional(t.UnionEnum(FORMALITY_VALUES)),
});

const config = {
  permissions: { entity: ["create"] },
  body: translateBody,
} satisfies HandlerConfig;

/**
 * Append the target language to the filename while preserving
 * the original extension. "Contract.docx" + "DE" → "Contract (DE).docx".
 */
const buildTranslatedFileName = (
  sourceFileName: string,
  targetLang: string,
): string => {
  const tag = ` (${targetLang.toUpperCase()})`;
  const lastDot = sourceFileName.lastIndexOf(".");
  if (lastDot === -1) {
    return `${sourceFileName}${tag}`;
  }
  return `${sourceFileName.slice(0, lastDot)}${tag}${sourceFileName.slice(lastDot)}`;
};

const translateEntity = createSafeHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
  }) {
    // 1. Resolve the org's DeepL key.
    const settingsRow = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            deeplApiKeyEncrypted: true,
            deeplApiKeyIv: true,
          },
        }),
      ),
    );

    const ciphertext = settingsRow?.deeplApiKeyEncrypted;
    const iv = settingsRow?.deeplApiKeyIv;
    if (!ciphertext || !iv) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "DeepL is not configured for this organisation. Add an API key in settings.",
        }),
      );
    }

    const apiKey = await decryptContent(
      session.activeOrganizationId,
      ciphertext,
      iv,
    );

    // 2. Look up the source field, scoped to this workspace.
    const fileRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ content: fields.content })
          .from(fields)
          .innerJoin(
            entityVersions,
            eq(fields.entityVersionId, entityVersions.id),
          )
          .innerJoin(
            entities,
            and(
              eq(entityVersions.entityId, entities.id),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .where(eq(fields.id, body.fieldId))
          .limit(1),
      ),
    );

    const fileRow = fileRows.at(0);
    if (!fileRow) {
      return Result.err(
        new HandlerError({ status: 404, message: "Source field not found" }),
      );
    }

    if (fileRow.content.type !== "file") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Field is not a file field",
        }),
      );
    }

    const sourceContent = fileRow.content;

    if (sourceContent.encrypted) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Encrypted files cannot be translated",
        }),
      );
    }

    if (!DEEPL_SUPPORTED_MIME_TYPES.has(sourceContent.mimeType)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `DeepL does not support ${sourceContent.mimeType}`,
        }),
      );
    }

    // 3. Fetch source bytes from S3.
    const sourceKey = createFileKey({
      organizationId: session.activeOrganizationId,
      workspaceId,
      fileId: sourceContent.id,
      mimeType: sourceContent.mimeType,
    });

    const sourceResponse = await fetch(
      getS3().presign(sourceKey, { expiresIn: 900 }),
      { signal: AbortSignal.timeout(60_000) },
    );

    if (!sourceResponse.ok) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Could not fetch the source file from storage",
        }),
      );
    }

    const sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer());

    // 4. Translate via DeepL.
    const translationResult = await Result.tryPromise({
      try: async () =>
        await translateDocument({
          apiKey,
          file: sourceBytes,
          fileName: sourceContent.fileName,
          mimeType: sourceContent.mimeType,
          targetLang: body.targetLang,
          sourceLang: body.sourceLang,
          formality: body.formality,
        }),
      catch: (error: unknown) => error,
    });

    if (translationResult.isErr()) {
      const error = translationResult.error;
      if (DeepLAuthError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "Stored DeepL key was rejected. Please rotate it in settings.",
          }),
        );
      }
      if (DeepLQuotaError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 402,
            message: "DeepL character quota exceeded for this organisation",
          }),
        );
      }
      if (DeepLRateLimitError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 429,
            message: "DeepL rate limit hit. Try again shortly.",
          }),
        );
      }
      if (DeepLTimeoutError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 502,
            message: "DeepL did not finish translating in time",
          }),
        );
      }
      if (DeepLDocumentError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: error.detail ?? "DeepL could not translate the document",
          }),
        );
      }
      if (DeepLUpstreamError.is(error)) {
        captureError(error);
        return Result.err(
          new HandlerError({
            status: 502,
            message: "DeepL request failed",
          }),
        );
      }
      throw error;
    }

    const translation = translationResult.value;

    // 5. Write the result back as a new entity.
    const createResult = await createEntityFromBuffer({
      scopedDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      buffer: translation.bytes,
      fileName: buildTranslatedFileName(
        sourceContent.fileName,
        body.targetLang,
      ),
      mimeType: sourceContent.mimeType,
    });

    if (Result.isError(createResult)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: createResult.error.message,
        }),
      );
    }

    return Result.ok({
      entityId: createResult.value.entityId,
      fileName: createResult.value.fileName,
      billedCharacters: translation.billedCharacters,
    });
  },
);

export default translateEntity;
